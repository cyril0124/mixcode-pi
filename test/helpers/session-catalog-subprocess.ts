import {
  listSessionsInBackground,
  runSessionCatalogWorkerCommand,
  SESSION_CATALOG_WORKER_ARG,
  type SessionCatalogRequest,
} from "../../src/core/session-catalog.js";

if (process.argv[2] === SESSION_CATALOG_WORKER_ARG) {
  const helperMode = process.env.CATALOG_TEST_MODE;
  if (helperMode === "late-failure") {
    process.stdout.write('{"type":"done","count":0}\n');
    process.stderr.write("catalog worker failed after output\n");
    process.exitCode = 7;
  } else if (helperMode === "truncated") {
    process.stdout.write('{"type":"session"');
  } else if (helperMode === "malformed-open") {
    process.stdout.write("{broken}\n");
    setInterval(() => {}, 1000);
  } else if (helperMode === "ignore-term") {
    process.on("SIGTERM", () => {});
    process.stdout.write('{"type":"done","count":0}\n');
    setInterval(() => {}, 1000);
  } else {
    await runSessionCatalogWorkerCommand(process.argv.slice(2));
  }
} else {
  const request = JSON.parse(process.argv[2]!) as SessionCatalogRequest;
  if (process.env.CATALOG_TEST_FAIL_RETRY) {
    process.env.CATALOG_TEST_MODE = "late-failure";
    try {
      await listSessionsInBackground(request);
      throw new Error("Expected worker failure");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("catalog worker failed"))
        throw error;
    }
    delete process.env.CATALOG_TEST_MODE;
    const retried = await listSessionsInBackground(request);
    process.stdout.write(JSON.stringify(retried));
  } else if (process.env.CATALOG_TEST_ABORT_RETRY) {
    process.env.CATALOG_TEST_MODE = "ignore-term";
    const abort = new AbortController();
    const first = listSessionsInBackground(request, abort.signal);
    setTimeout(() => abort.abort(), 200);
    try {
      await first;
      throw new Error("Expected cancellation");
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    }
    delete process.env.CATALOG_TEST_MODE;
    const retried = await listSessionsInBackground(request);
    process.stdout.write(JSON.stringify(retried));
  } else {
    const sessions = await listSessionsInBackground(request);
    process.stdout.write(JSON.stringify(sessions));
  }
}
