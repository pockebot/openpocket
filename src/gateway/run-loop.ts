export interface GatewayLoopHandle {
  stop: (reason?: string) => Promise<void> | void;
}

export type GatewayRunLoopParams = {
  start: () => Promise<GatewayLoopHandle>;
  log?: (line: string) => void;
};

export async function runGatewayLoop(params: GatewayRunLoopParams): Promise<void> {
  const log =
    params.log ??
    ((line: string) => {
      // eslint-disable-next-line no-console
      console.log(line);
    });

  let current: GatewayLoopHandle | null = null;
  let waitResolver: (() => void) | null = null;
  let shuttingDown = false;
  let restarting = false;

  const request = (action: "stop" | "restart", signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      log(
        `[OpenPocket][gateway-loop][warn] ${new Date().toISOString()} signal=${signal} received again — forcing exit`,
      );
      process.exit(1);
    }
    shuttingDown = true;
    restarting = action === "restart";
    log(
      `[OpenPocket][gateway-loop][warn] ${new Date().toISOString()} signal=${signal} action=${restarting ? "restart" : "stop"} (press Ctrl+C again to force quit)`,
    );
    void Promise.resolve(current?.stop(`signal:${signal}`))
      .catch(() => {
        // Ignore stop errors while shutting down.
      })
      .finally(() => {
        waitResolver?.();
      });
  };

  const onSigterm = () => request("stop", "SIGTERM");
  const onSigint = () => request("stop", "SIGINT");
  const onSigusr1 = () => request("restart", "SIGUSR1");

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      shuttingDown = false;
      restarting = false;
      current = await params.start();
      await new Promise<void>((resolve) => {
        waitResolver = resolve;
      });
      waitResolver = null;
      current = null;
      if (!restarting) {
        break;
      }
      log(`[OpenPocket][gateway-loop][info] ${new Date().toISOString()} restarting gateway`);
    }
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  }
}
