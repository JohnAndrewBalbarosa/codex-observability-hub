import { createHash, randomBytes } from "node:crypto";
import { v5 as uuid5, v7 as uuid7 } from "uuid";

const endpoint = process.env.OBS_ENDPOINT || "http://127.0.0.1:4319";
const redactKeys = /password|passwd|secret|token|api[_-]?key|cookie|authorization|private[_-]?key/i;
const clean = value => {
  if (Array.isArray(value)) return value.slice(0,100).map(clean);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,redactKeys.test(key) ? "[REDACTED]" : clean(item)]));
  return typeof value === "string" ? value.slice(0,1200) : value;
};

export class ObservabilityClient {
  constructor({ projectId, executionId, traceId, component = "application", strict = false }) {
    Object.assign(this,{ projectId,executionId,traceId,component,strict });
    this.sequence = 0;
  }
  static async start({ projectId, component = "application", commitSha, branchName, dirtyFingerprint, buildVersion, executionKind = 2, strict = false }) {
    const occurredAt = new Date().toISOString();
    const versionKey = `${projectId}|${commitSha || ""}|${dirtyFingerprint || ""}`;
    const codeVersionId = uuid5(versionKey,uuid5.URL), executionId = uuid7(), traceId = randomBytes(16).toString("hex");
    const operations = [
      { operationId:uuid7(),kind:"code-version.register",occurredAt,data:{codeVersionId,projectId,commitSha,branchName,dirtyFingerprint,buildVersion} },
      { operationId:uuid7(),kind:"execution.start",occurredAt,data:{executionId,projectId,codeVersionId,executionKind,attemptNo:1,traceId} },
    ];
    try {
      const response = await fetch(`${endpoint}/v1/operations`,{ method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operations:clean(operations)}) });
      if (!response.ok) throw new Error(`Observability ingestion failed with HTTP ${response.status}`);
    } catch (error) { if (strict) throw error; }
    return new ObservabilityClient({projectId,executionId,traceId,component,strict});
  }
  async emit({ code, category = 1, severity = 1, outcome, message = "", attributes = {} }) {
    const occurredAt = new Date().toISOString();
    const operation = { operationId:uuid7(),kind:"event.emit",occurredAt,data:clean({ eventId:uuid7(),executionId:this.executionId,projectId:this.projectId,traceId:this.traceId,sequenceNo:++this.sequence,code,category,severity,outcome,component:this.component,messageSummary:message,attributes }) };
    try {
      const response = await fetch(`${endpoint}/v1/operations`,{ method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operations:[operation]}) });
      if (!response.ok) throw new Error(`Observability ingestion failed with HTTP ${response.status}`);
      return true;
    } catch (error) { if (this.strict) throw error; return false; }
  }
  async finish({ outcome = 1, status = 2, resultSummary = "" } = {}) {
    const operation = { operationId:uuid7(),kind:"execution.finish",occurredAt:new Date().toISOString(),data:{executionId:this.executionId,outcome,status,resultSummary} };
    try {
      const response = await fetch(`${endpoint}/v1/operations`,{ method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operations:[operation]}) });
      if (!response.ok) throw new Error(`Observability ingestion failed with HTTP ${response.status}`);
      return true;
    } catch (error) { if (this.strict) throw error; return false; }
  }
  static fingerprint(...parts) { return createHash("sha256").update(parts.join("|")).digest("hex"); }
}
