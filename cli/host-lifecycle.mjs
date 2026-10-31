// Observe termination only. A timeout never sends a force-kill or removes metadata.
export async function waitForHostExit(pid, {timeoutMs = 30000} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid host process identity');
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw new Error(`Cannot observe Vek Browser process ${pid}: ${error.message}`); }
    if (performance.now() >= deadline) throw new Error(`Shutdown requested, but Vek Browser process ${pid} has not exited after ${timeoutMs} ms. It may still be finishing active work; no force-kill was sent.`);
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
  }
}
export function shutdownTimeout(args) {
  if (!args.length) return 30000;
  if (args.length !== 2 || args[0] !== '--timeout-ms' || !/^\d+$/.test(args[1])) throw new Error('Usage: vek-browser stop [--timeout-ms 100..120000]');
  const timeout = Number(args[1]);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000) throw new Error('Shutdown timeout must be 100..120000 ms');
  return timeout;
}
