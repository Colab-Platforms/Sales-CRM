import { parse } from "csv-parse/sync";
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { normalizeEmail, normalizeMobile } from "@/lib/leadIdentity.js";
import { ApplicationStatus, ImportBatchStatus, Role, UserStatus } from "../../../generated/prisma/enums.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { AuthUser } from "@/middlewares/auth.js";
import type { ListQuery } from "./recruitment.validators.js";

type ImportField = "name" | "mobile" | "email" | "resumeUrl";

interface ParsedApplicationRow {
  name: string;
  mobile: string;
  normalizedMobile: string;
  email?: string;
  resumeUrl?: string;
  extra?: Record<string, string>;
}

// A spreadsheet opens a cell starting with = + - @ as a formula; prefix it so exported text stays text.
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

class RecruitmentService {
  // ---- Jobs ----

  async createJob(user: AuthUser, data: { title: string; department?: string; location?: string }) {
    return prisma.job.create({ data: { ...data, createdById: user.id } });
  }

  async updateJob(id: string, data: { title?: string; department?: string; location?: string; status?: "OPEN" | "CLOSED" }) {
    await this.getJobOrThrow(id);
    return prisma.job.update({ where: { id }, data });
  }

  private async getJobOrThrow(id: string) {
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) throw new ApiError("Job not found", STATUS_CODES.NOT_FOUND);
    return job;
  }

  async listJobs() {
    const [jobs, grouped] = await Promise.all([
      prisma.job.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.application.groupBy({ by: ["jobId", "status"], _count: { _all: true } }),
    ]);
    return jobs.map((job) => {
      const rows = grouped.filter((g) => g.jobId === job.id);
      const total = rows.reduce((n, r) => n + r._count._all, 0);
      const unassigned = rows.filter((r) => r.status === ApplicationStatus.NEW).reduce((n, r) => n + r._count._all, 0);
      return { ...job, totalApplications: total, unassignedApplications: unassigned };
    });
  }

  async getJob(id: string) {
    return this.getJobOrThrow(id);
  }

  // ---- CSV import (preview, then confirm; same two-step flow as lead imports) ----

  async previewImport(user: AuthUser, jobId: string, file: Express.Multer.File, columnMapping: Record<string, ImportField>) {
    await this.getJobOrThrow(jobId);

    let rawRows: Record<string, string>[];
    try {
      rawRows = parse(file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch {
      throw new ApiError("Could not read the CSV file", STATUS_CODES.BAD_REQUEST);
    }
    if (rawRows.length === 0) throw new ApiError("The CSV file has no rows", STATUS_CODES.BAD_REQUEST);

    const mappedColumns = new Set(Object.keys(columnMapping));
    const columnFor = (field: ImportField) => Object.keys(columnMapping).find((c) => columnMapping[c] === field);
    const valueOf = (row: Record<string, string>, field: ImportField) => {
      const column = columnFor(field);
      return column ? row[column]?.trim() : undefined;
    };

    const parsedRows: ParsedApplicationRow[] = [];
    const errorRows: { row: number; reason: string }[] = [];
    const seen = new Set<string>();

    const candidateMobiles = rawRows.map((row) => normalizeMobile(valueOf(row, "mobile"))).filter((v): v is string => Boolean(v));
    const existing = await prisma.application.findMany({
      where: { jobId, normalizedMobile: { in: candidateMobiles } },
      select: { normalizedMobile: true },
    });
    const existingMobiles = new Set(existing.map((e) => e.normalizedMobile));

    rawRows.forEach((row, index) => {
      const rowNumber = index + 2; // header is row 1
      const name = valueOf(row, "name");
      const mobile = valueOf(row, "mobile");
      const normalizedMobile = normalizeMobile(mobile);
      if (!name) return void errorRows.push({ row: rowNumber, reason: "Missing name" });
      if (!mobile || !normalizedMobile) return void errorRows.push({ row: rowNumber, reason: "Missing or invalid mobile" });
      if (existingMobiles.has(normalizedMobile) || seen.has(normalizedMobile)) {
        return void errorRows.push({ row: rowNumber, reason: "Duplicate mobile for this job" });
      }
      seen.add(normalizedMobile);

      const extra: Record<string, string> = {};
      for (const [column, value] of Object.entries(row)) if (!mappedColumns.has(column) && value) extra[column] = value;

      parsedRows.push({
        name,
        mobile,
        normalizedMobile,
        email: normalizeEmail(valueOf(row, "email")) ?? undefined,
        resumeUrl: valueOf(row, "resumeUrl") || undefined,
        extra: Object.keys(extra).length ? extra : undefined,
      });
    });

    const duplicateCount = errorRows.filter((e) => e.reason.startsWith("Duplicate")).length;
    const batch = await prisma.applicationImportBatch.create({
      data: {
        jobId,
        fileName: file.originalname,
        columnMapping,
        parsedRows: parsedRows as unknown as Prisma.InputJsonValue,
        errorRows: errorRows as unknown as Prisma.InputJsonValue,
        totalRows: rawRows.length,
        duplicateCount,
        createdById: user.id,
      },
    });

    return {
      batchId: batch.id,
      totalRows: rawRows.length,
      validRows: parsedRows.length,
      duplicateRows: duplicateCount,
      invalidRows: errorRows.length - duplicateCount,
      sampleErrors: errorRows.slice(0, 20),
    };
  }

  async confirmImport(batchId: string) {
    const batch = await prisma.applicationImportBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new ApiError("Import batch not found", STATUS_CODES.NOT_FOUND);
    if (batch.status !== ImportBatchStatus.DRAFT) throw new ApiError("Import batch already processed", STATUS_CODES.CONFLICT);

    const rows = (batch.parsedRows as unknown as ParsedApplicationRow[]) ?? [];
    if (rows.length === 0) throw new ApiError("No valid rows to import", STATUS_CODES.BAD_REQUEST);

    // skipDuplicates covers a row that another batch imported between preview and confirm.
    const created = await prisma.application.createMany({
      data: rows.map((r) => ({
        jobId: batch.jobId,
        name: r.name,
        mobile: r.mobile,
        normalizedMobile: r.normalizedMobile,
        email: r.email,
        resumeUrl: r.resumeUrl,
        extra: r.extra as Prisma.InputJsonValue | undefined,
        importBatchId: batch.id,
      })),
      skipDuplicates: true,
    });
    await prisma.applicationImportBatch.update({
      where: { id: batch.id },
      data: { status: ImportBatchStatus.COMMITTED, importedCount: created.count },
    });
    return { batchId: batch.id, importedCount: created.count, skippedCount: rows.length - created.count };
  }

  // ---- Manual entry ----

  // HR/admin add an unassigned application; a recruiter adds one straight into their own queue.
  async createApplication(
    user: AuthUser,
    data: { jobId: string; name: string; mobile: string; email?: string; resumeUrl?: string; notes?: string },
  ) {
    await this.getJobOrThrow(data.jobId);
    const normalizedMobile = normalizeMobile(data.mobile);
    if (!normalizedMobile) throw new ApiError("Enter a valid mobile number", STATUS_CODES.BAD_REQUEST);

    const duplicate = await prisma.application.findUnique({
      where: { jobId_normalizedMobile: { jobId: data.jobId, normalizedMobile } },
      select: { id: true },
    });
    if (duplicate) throw new ApiError("An application with this mobile number already exists for this job", STATUS_CODES.CONFLICT);

    const isRecruiter = user.role === Role.RECRUITER;
    return prisma.$transaction(async (tx) => {
      const application = await tx.application.create({
        data: {
          jobId: data.jobId,
          name: data.name,
          mobile: data.mobile,
          normalizedMobile,
          email: normalizeEmail(data.email) ?? undefined,
          resumeUrl: data.resumeUrl || undefined,
          notes: data.notes || undefined,
          recruiterId: isRecruiter ? user.id : undefined,
          status: isRecruiter ? ApplicationStatus.ASSIGNED : ApplicationStatus.NEW,
        },
      });
      if (isRecruiter) {
        await tx.applicationAssignment.create({
          data: { applicationId: application.id, recruiterId: user.id, assignedById: user.id },
        });
      }
      return application;
    });
  }

  // ---- Listing ----

  private listWhere(user: AuthUser, query: ListQuery, jobId?: string): Prisma.ApplicationWhereInput {
    const where: Prisma.ApplicationWhereInput = {};
    const scopedJobId = jobId ?? query.jobId;
    if (scopedJobId) where.jobId = scopedJobId;
    if (query.status) where.status = query.status;
    // A recruiter only ever sees what is assigned to them, whatever filters they send.
    if (user.role === Role.RECRUITER) where.recruiterId = user.id;
    else if (query.recruiterId === "unassigned") where.recruiterId = null;
    else if (query.recruiterId) where.recruiterId = query.recruiterId;
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: "insensitive" } },
        { email: { contains: query.q, mode: "insensitive" } },
        { mobile: { contains: query.q } },
      ];
    }
    return where;
  }

  async listApplications(user: AuthUser, query: ListQuery, jobId?: string) {
    const where = this.listWhere(user, query, jobId);
    const [items, total] = await Promise.all([
      prisma.application.findMany({
        where,
        include: { recruiter: { select: { id: true, name: true } }, job: { select: { id: true, title: true } } },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.application.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getApplication(user: AuthUser, id: string) {
    const application = await prisma.application.findUnique({
      where: { id },
      include: { recruiter: { select: { id: true, name: true } }, job: { select: { id: true, title: true } } },
    });
    // 404 (not 403) so a recruiter can't probe for applications held by someone else.
    if (!application || (user.role === Role.RECRUITER && application.recruiterId !== user.id)) {
      throw new ApiError("Application not found", STATUS_CODES.NOT_FOUND);
    }
    return application;
  }

  async updateApplication(user: AuthUser, id: string, data: { status?: ApplicationStatus; notes?: string }) {
    await this.getApplication(user, id);
    return prisma.application.update({ where: { id }, data });
  }

  // ---- Assignment ----

  async assign(user: AuthUser, body: { applicationIds: string[]; recruiterIds: string[] }) {
    const recruiterIds = [...new Set(body.recruiterIds)];
    const recruiters = await prisma.user.findMany({
      where: { id: { in: recruiterIds }, role: Role.RECRUITER, status: UserStatus.ACTIVE },
      select: { id: true },
    });
    if (recruiters.length !== recruiterIds.length) throw new ApiError("Invalid or inactive recruiter", STATUS_CODES.BAD_REQUEST);

    const applicationIds = [...new Set(body.applicationIds)];
    const applications = await prisma.application.findMany({
      where: { id: { in: applicationIds } },
      select: { id: true, recruiterId: true },
      orderBy: { id: "asc" },
    });
    if (applications.length !== applicationIds.length) throw new ApiError("One or more applications were not found", STATUS_CODES.NOT_FOUND);

    // Even split in a stable order: application i goes to recruiter i mod n.
    const plan = applications
      .map((app, i) => ({ app, recruiterId: recruiterIds[i % recruiterIds.length]! }))
      .filter(({ app, recruiterId }) => app.recruiterId !== recruiterId);

    await prisma.$transaction(
      async (tx) => {
        for (const recruiterId of recruiterIds) {
          const ids = plan.filter((p) => p.recruiterId === recruiterId).map((p) => p.app.id);
          if (ids.length === 0) continue;
          await tx.applicationAssignment.updateMany({ where: { applicationId: { in: ids }, isCurrent: true }, data: { isCurrent: false } });
          await tx.applicationAssignment.createMany({
            data: ids.map((applicationId) => ({ applicationId, recruiterId, assignedById: user.id })),
          });
          await tx.application.updateMany({ where: { id: { in: ids } }, data: { recruiterId } });
          // A fresh application becomes ASSIGNED; one already being worked keeps its status.
          await tx.application.updateMany({
            where: { id: { in: ids }, status: ApplicationStatus.NEW },
            data: { status: ApplicationStatus.ASSIGNED },
          });
        }
      },
      { timeout: 20000, maxWait: 10000 },
    );
    return { assignedCount: plan.length, unchangedCount: applications.length - plan.length };
  }

  // Per-recruiter workload, for HR's distribution view.
  async distribution(jobId?: string) {
    const [recruiters, grouped] = await Promise.all([
      prisma.user.findMany({
        where: { role: Role.RECRUITER },
        select: { id: true, name: true, status: true },
        orderBy: { name: "asc" },
      }),
      prisma.application.groupBy({
        by: ["recruiterId", "status"],
        where: jobId ? { jobId } : {},
        _count: { _all: true },
      }),
    ]);
    const count = (recruiterId: string | null, statuses?: ApplicationStatus[]) =>
      grouped
        .filter((g) => g.recruiterId === recruiterId && (!statuses || statuses.includes(g.status)))
        .reduce((n, g) => n + g._count._all, 0);
    const pending: ApplicationStatus[] = [
      ApplicationStatus.ASSIGNED,
      ApplicationStatus.RINGING,
      ApplicationStatus.CALL_BACK,
      ApplicationStatus.NOT_REACHABLE,
    ];
    return {
      unassigned: count(null),
      recruiters: recruiters.map((r) => ({
        ...r,
        total: count(r.id),
        pending: count(r.id, pending),
        shortlisted: count(r.id, [ApplicationStatus.SHORTLISTED, ApplicationStatus.HIRED]),
      })),
    };
  }

  // ---- Export ----

  async exportCsv(jobId: string): Promise<{ filename: string; csv: string }> {
    const job = await this.getJobOrThrow(jobId);
    const applications = await prisma.application.findMany({
      where: { jobId },
      include: {
        recruiter: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const extraOf = (a: { extra: Prisma.JsonValue }) => (a.extra as Record<string, string> | null) ?? {};
    const extraKeys = [...new Set(applications.flatMap((a) => Object.keys(extraOf(a))))];
    const header = ["Name", "Mobile", "Email", "Resume URL", "Status", "Recruiter", "Notes", ...extraKeys];
    const lines = [header.map(csvCell).join(",")];
    for (const a of applications) {
      const extra = extraOf(a);
      lines.push(
        [
          a.name,
          a.mobile,
          a.email,
          a.resumeUrl,
          a.status,
          a.recruiter?.name,
          a.notes,
          ...extraKeys.map((k) => extra[k]),
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const safeTitle = job.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "job";
    // BOM so Excel reads the UTF-8 correctly.
    return { filename: `applications-${safeTitle}.csv`, csv: `﻿${lines.join("\r\n")}\r\n` };
  }
}

export default RecruitmentService;
