// deno-lint-ignore-file no-var
import * as system from "../../system.js";
import * as blocklists from "./blocklists.ts";
import * as dbip from "./dbip.ts";
import { services, stopAfter } from "../svc.js";
import Log, { setLogger } from "../log.js";
import EnvManager from "../env.js";

type LogLevels = "error" | "logpush" | "warn" | "info" | "timer" | "debug";

// In global scope.
declare global {
  // TypeScript must know type of every var / property. Extend Window
  // (globalThis) with declaration merging (archive.is/YUWh2) to define types
  // Ref: www.typescriptlang.org/docs/handbook/declaration-merging.html
  var envManager: EnvManager | null;
  var env: any | null;
}

((main) => {
  system.when("prepare").then(prep);
  system.when("steady").then(up);
})();

function prep() {
  // if this file execs... assume we're on deno.
  if (!Deno) throw new Error("failed loading deno-specific config");

  const envFor = (k: string): string | undefined => Deno.env.get(k) ?? undefined;
  const isProd = envFor("DENO_ENV_DOMAIN") === "production";
  // Detect Deno Deploy robustly: Deploy does not set `CLOUD_PLATFORM`, but
  // sets `DENO_DEPLOY=true` during builds and `DENO_DEPLOYMENT_ID` at runtime.
  const onDenoDeploy =
    envFor("CLOUD_PLATFORM") === "deno-deploy" ||
    envFor("DENO_DEPLOY") === "true" ||
    envFor("DENO_DEPLOYMENT_ID") != null;
  const profiling = envFor("PROFILE_DNS_RESOLVES") === "true";

  globalThis.envManager = new EnvManager();

  const logger = new Log({
    level: globalThis.envManager.get("LOG_LEVEL") as LogLevels,
    levelize: isProd || profiling, // levelize if prod or profiling
    withTimestamps: !onDenoDeploy, // do not log ts on deno-deploy
  });
  setLogger(logger);

  // signal ready
  system.pub("ready");
}

async function up() {
  try {
    if (!services.ready) {
      console.error("services not yet ready and there is a sig-up!?");
      return;
    }

    const bw = services.blocklistWrapper;
    if (bw != null && !bw.disabled()) {
      try {
        await blocklists.setup(bw);
      } catch (ex) {
        console.error("Config", "blocklists setup failed", ex);
      }
    } else {
      console.warn("Config", "blocklists unavailable / disabled");
    }
    const lp = services.logPusher;
    if (lp != null) {
      try {
        await dbip.setup(lp);
      } catch (ex) {
        console.error("Config", "dbip setup failed", ex);
      }
    } else {
      console.warn("Config", "logpusher unavailable");
    }
  } catch (ex) {
    console.error("Config", "deno up failed", ex);
  } finally {
    // docs.deno.com/runtime/tutorials/os_signals
    // NB: signal registration must never block the "go" event (Deno Deploy
    // would otherwise never reach Deno.serve() and reply 500 to every request).
    try {
      Deno.addSignalListener("SIGINT", () => {
        stopAfter();
      });
    } catch (ex) {
      console.error("Config", "signal listener unavailable", ex);
    }

    // NB: emit "go" only after the current macrotask drains so every "go"
    // subscriber (notably the server entrypoint) is registered before
    // Deno.serve() must start. util.timeout() unrefs its timer, which would
    // let this Deno process exit before serving; use a ref’d setTimeout.
    setTimeout(() => system.pub("go"), 50);
  }
}
