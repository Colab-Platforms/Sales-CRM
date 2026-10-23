// An agent talking on the phone keeps ON_CALL when their browser goes quiet, and reconnecting mid-call
// goes back to ON_CALL (not ACTIVE). Prisma is stubbed in place, so no database is involved.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkStatus } from "../../../generated/prisma/enums.js";

process.env.DATABASE_URL ||= "postgresql://stub:stub@127.0.0.1:1/stub";
const { prisma } = await import("@/lib/prisma.js");
const { default: AttendanceService } = await import("./attendance.service.js");

type Transition = { from: WorkStatus; to: WorkStatus };
type Internals = {
  transition: (sessionId: string, userId: string, from: WorkStatus, to: WorkStatus) => Promise<void>;
  markConnected: (userId: string) => Promise<void>;
  markIdleIfWorking: (sessionId: string, userId: string, status: WorkStatus) => Promise<void>;
};

const USER = "u1";
const realFindFirst = prisma.workSession.findFirst;
const realUpdate = prisma.workSession.update;
const realCallCount = prisma.call.count;

let transitions: Transition[];
let callCountWhere: unknown;
let service: Internals;

function stub(currentStatus: WorkStatus, openCalls: number) {
  (prisma.workSession as any).findFirst = async () => ({ id: "s1", userId: USER, currentStatus, statusLogs: [] });
  (prisma.workSession as any).update = async () => ({});
  (prisma.call as any).count = async (args: unknown) => {
    callCountWhere = args;
    return openCalls;
  };
}

beforeEach(() => {
  transitions = [];
  callCountWhere = undefined;
  service = new AttendanceService() as unknown as Internals;
  service.transition = async (_sessionId, _userId, from, to) => {
    transitions.push({ from, to });
  };
});

afterEach(() => {
  (prisma.workSession as any).findFirst = realFindFirst;
  (prisma.workSession as any).update = realUpdate;
  (prisma.call as any).count = realCallCount;
});

describe("browser goes quiet while ON_CALL", () => {
  it("stays ON_CALL when a call is still open", async () => {
    stub(WorkStatus.ON_CALL, 1);
    await service.markIdleIfWorking("s1", USER, WorkStatus.ON_CALL);
    assert.deepEqual(transitions, []);
  });

  it("turns IDLE when no call is open", async () => {
    stub(WorkStatus.ON_CALL, 0);
    await service.markIdleIfWorking("s1", USER, WorkStatus.ON_CALL);
    assert.deepEqual(transitions, [{ from: WorkStatus.ON_CALL, to: WorkStatus.IDLE }]);
  });

  it("an ACTIVE agent still turns IDLE and the call table is not consulted", async () => {
    stub(WorkStatus.ACTIVE, 1);
    await service.markIdleIfWorking("s1", USER, WorkStatus.ACTIVE);
    assert.deepEqual(transitions, [{ from: WorkStatus.ACTIVE, to: WorkStatus.IDLE }]);
    assert.equal(callCountWhere, undefined);
  });

  it("a break is left alone", async () => {
    stub(WorkStatus.TEA_BREAK, 1);
    await service.markIdleIfWorking("s1", USER, WorkStatus.TEA_BREAK);
    assert.deepEqual(transitions, []);
  });

  it("only counts the agent's own unfinished calls", async () => {
    stub(WorkStatus.ON_CALL, 1);
    await service.markIdleIfWorking("s1", USER, WorkStatus.ON_CALL);
    const where = (callCountWhere as { where: { agentId: string; status: { notIn: string[] } } }).where;
    assert.equal(where.agentId, USER);
    assert.ok(where.status.notIn.includes("COMPLETED"));
    assert.ok(!where.status.notIn.includes("CONNECTED"));
  });
});

describe("browser reconnects after IDLE", () => {
  it("goes back to ON_CALL when a call is still open", async () => {
    stub(WorkStatus.IDLE, 1);
    await service.markConnected(USER);
    assert.deepEqual(transitions, [{ from: WorkStatus.IDLE, to: WorkStatus.ON_CALL }]);
  });

  it("goes to ACTIVE when no call is open", async () => {
    stub(WorkStatus.IDLE, 0);
    await service.markConnected(USER);
    assert.deepEqual(transitions, [{ from: WorkStatus.IDLE, to: WorkStatus.ACTIVE }]);
  });

  it("does not change a status that is not IDLE", async () => {
    stub(WorkStatus.ON_CALL, 1);
    await service.markConnected(USER);
    assert.deepEqual(transitions, []);
  });
});
