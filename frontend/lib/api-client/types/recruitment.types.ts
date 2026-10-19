export type ApplicationStatus =
  | "NEW"
  | "ASSIGNED"
  | "RINGING"
  | "NOT_REACHABLE"
  | "CALL_BACK"
  | "SCREENED"
  | "SHORTLISTED"
  | "REJECTED"
  | "HIRED"
  | "NOT_INTERESTED";

export const APPLICATION_STATUSES: ApplicationStatus[] = [
  "NEW",
  "ASSIGNED",
  "RINGING",
  "NOT_REACHABLE",
  "CALL_BACK",
  "SCREENED",
  "SHORTLISTED",
  "REJECTED",
  "HIRED",
  "NOT_INTERESTED",
];

/** Statuses offered in list filters (HR sees New = not yet assigned). */
export const FILTER_STATUSES: ApplicationStatus[] = ["NEW", "ASSIGNED", "SCREENED", "SHORTLISTED", "HIRED", "REJECTED"];

/** The outcomes a recruiter records by hand after calling a candidate. */
export const RECRUITER_STATUSES: ApplicationStatus[] = ["SCREENED", "SHORTLISTED", "HIRED", "REJECTED"];

export interface CreateApplicationPayload {
  jobId: string;
  name: string;
  mobile: string;
  email?: string;
  resumeUrl?: string;
  notes?: string;
}

export type JobStatus = "OPEN" | "CLOSED";

export interface Job {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  status: JobStatus;
  createdAt: string;
}

export interface JobSummary extends Job {
  totalApplications: number;
  unassignedApplications: number;
}

export interface CreateJobPayload {
  title: string;
  department?: string;
  location?: string;
}

export interface UpdateJobPayload extends Partial<CreateJobPayload> {
  status?: JobStatus;
}

export interface Application {
  id: string;
  jobId: string;
  name: string;
  mobile: string;
  email: string | null;
  resumeUrl: string | null;
  extra: Record<string, string> | null;
  status: ApplicationStatus;
  notes: string | null;
  recruiterId: string | null;
  recruiter: { id: string; name: string } | null;
  job: { id: string; title: string };
  createdAt: string;
}

export interface ApplicationPage {
  items: Application[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApplicationListParams {
  page?: number;
  pageSize?: number;
  status?: ApplicationStatus | "";
  /** A recruiter id, or "unassigned". Ignored for a recruiter (always scoped to themselves). */
  recruiterId?: string;
  jobId?: string;
  q?: string;
}

export type ImportField = "name" | "mobile" | "email" | "resumeUrl";

export interface ApplicationImportPreview {
  batchId: string;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRows: number;
  sampleErrors: { row: number; reason: string }[];
}

export interface ApplicationImportResult {
  batchId: string;
  importedCount: number;
  skippedCount: number;
}

export interface AssignApplicationsPayload {
  applicationIds: string[];
  /** One id = assign all to that recruiter; several = spread evenly. */
  recruiterIds: string[];
}

export interface RecruitmentDistribution {
  unassigned: number;
  recruiters: { id: string; name: string; status: string; total: number; pending: number; shortlisted: number }[];
}
