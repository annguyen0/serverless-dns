/**
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";

const preScript = new URL("./pre.ts", import.meta.url);
const basicConfigPath = "./src/u6-basicconfig.json";
const filetagPath = "./src/u6-filetag.json";

type FetchResult = Response | Error;

interface RunOptions {
  now?: string;
  statResults?: boolean[];
  fetch: (url: string, requestNumber: number) => FetchResult;
}

interface RunResult {
  exitCode: number | undefined;
  fetches: string[];
  logs: string[];
  reads: string[];
  removes: string[];
  stats: string[];
  writes: Array<{ path: string; data: string }>;
}

let importNumber = 0;

/** Runs the executable module with deterministic in-memory I/O. */
async function runPre(options: RunOptions): Promise<RunResult> {
  const original = {
    dateNow: Date.now,
    error: console.error,
    exit: Deno.exit,
    fetch: globalThis.fetch,
    log: console.log,
    readTextFile: Deno.readTextFile,
    remove: Deno.remove,
    stat: Deno.stat,
    writeTextFile: Deno.writeTextFile,
  };
  const files = new Map<string, string>();
  const result: RunResult = {
    exitCode: undefined,
    fetches: [],
    logs: [],
    reads: [],
    removes: [],
    stats: [],
    writes: [],
  };
  let statNumber = 0;
  let finished = false;
  let finish: () => void = () => {};
  const terminal = new Promise<void>((resolve) => {
    finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };
  });

  try {
    Date.now = () => new Date(options.now ?? "2026-09-09T12:00:00Z").valueOf();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      result.fetches.push(url);
      const next = options.fetch(url, result.fetches.length);
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch;
    Deno.stat = (async (path: string | URL) => {
      const key = path.toString();
      result.stats.push(key);
      const exists = options.statResults?.[statNumber++] ?? false;
      if (!exists) throw new Deno.errors.NotFound(key);
      return {} as Deno.FileInfo;
    }) as typeof Deno.stat;
    Deno.writeTextFile = (async (path: string | URL, data: string) => {
      const key = path.toString();
      result.writes.push({ path: key, data });
      files.set(key, data);
    }) as typeof Deno.writeTextFile;
    Deno.readTextFile = (async (path: string | URL) => {
      const key = path.toString();
      result.reads.push(key);
      const data = files.get(key);
      if (data === undefined) throw new Deno.errors.NotFound(key);
      return data;
    }) as typeof Deno.readTextFile;
    Deno.remove = (async (path: string | URL) => {
      const key = path.toString();
      result.removes.push(key);
      if (!files.delete(key)) throw new Deno.errors.NotFound(key);
    }) as typeof Deno.remove;
    Deno.exit = ((code = 0) => {
      result.exitCode = code;
      finish();
      return undefined as never;
    }) as typeof Deno.exit;

    const recordLog = (...parts: unknown[]) => {
      const message = parts.map(String).join(" ");
      result.logs.push(message);
      if (
        message.includes("pre.ts: success") ||
        message.includes("pre.ts: no op") ||
        message.includes("pre.ts: all tries failed")
      ) {
        finish();
      }
    };
    console.log = recordLog;
    console.error = recordLog;

    await import(`${preScript.href}?test-run=${importNumber++}`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        terminal,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("pre.ts did not finish")),
            2_000
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    // Let the final continuation after the terminal log or mocked exit settle.
    await Promise.resolve();
    await Promise.resolve();
    return result;
  } finally {
    Date.now = original.dateNow;
    globalThis.fetch = original.fetch;
    Deno.stat = original.stat;
    Deno.writeTextFile = original.writeTextFile;
    Deno.readTextFile = original.readTextFile;
    Deno.remove = original.remove;
    Deno.exit = original.exit;
    console.log = original.log;
    console.error = original.error;
  }
}

function successfulFetch(basicConfig: string) {
  return (url: string): FetchResult => {
    if (url.endsWith("/basicconfig.json")) {
      return new Response(basicConfig);
    }
    if (url.endsWith("/filetag.json")) {
      return new Response('{"tags":[]}');
    }
    return new Response(null, { status: 404 });
  };
}

Deno.test(
  "prepare task runs the Deno-native script with its required permissions",
  async () => {
    const denoConfig = JSON.parse(await Deno.readTextFile("./deno.json"));

    assert.equal(
      denoConfig.tasks.prepare,
      "deno run --allow-net --allow-read --allow-write ./src/build/pre.ts"
    );
  }
);

Deno.test(
  "deployment workflow uses the Deno CLI and token authentication",
  async () => {
    const workflow = await Deno.readTextFile(
      "./.github/workflows/deno-deploy.yml"
    );
    const deployStep = workflow.slice(
      workflow.indexOf("- name: 🤸🏼 Deploy to deno.com"),
      workflow.indexOf("- name: 🚢 Merge latest code")
    );

    assert.match(deployStep, /\bdeno deploy\b/);
    assert.doesNotMatch(deployStep, /denoland\/deployctl/);
    assert.match(
      deployStep,
      /DENO_DEPLOY_TOKEN:\s*\$\{\{ secrets\.DENO_DEPLOY_TOKEN \}\}/
    );
  }
);

Deno.test(
  "deployment command does not interpolate workflow values into shell code",
  async () => {
    const workflow = await Deno.readTextFile(
      "./.github/workflows/deno-deploy.yml"
    );
    const deployStep = workflow.slice(
      workflow.indexOf("- name: 🤸🏼 Deploy to deno.com"),
      workflow.indexOf("- name: 🚢 Merge latest code")
    );
    const runBlock = deployStep.slice(
      deployStep.indexOf("run: |"),
      deployStep.indexOf("env:")
    );

    assert.doesNotMatch(runBlock, /\$\{\{/);
    assert.match(runBlock, /"\$PROJECT_NAME"/);
    assert.doesNotMatch(runBlock, /--entrypoint\s+[^"\s]/);
  }
);

Deno.test("skips downloads only when both generated files exist", async () => {
  const run = await runPre({
    statResults: [true, true],
    fetch: () => new Response(null, { status: 500 }),
  });

  assert.deepEqual(run.stats, [basicConfigPath, filetagPath]);
  assert.deepEqual(run.fetches, []);
  assert.equal(run.exitCode, undefined);
});

Deno.test(
  "a partial previous result is repaired instead of treated as complete",
  async () => {
    const config = "a,b,c,d,e,f,g,h,updated:2026/1788910929265";
    const run = await runPre({
      statResults: [true, false],
      fetch: successfulFetch(config),
    });

    assert.equal(run.fetches.length, 2);
    assert.deepEqual(
      run.writes.map(({ path }) => path),
      [basicConfigPath, filetagPath]
    );
    assert.equal(run.exitCode, undefined);
  }
);

Deno.test(
  "downloads the current UTC week and follows a field-nine filetag",
  async () => {
    const config = "a,b,c,d,e,f,g,h,updated:2026/1788910929265";
    const run = await runPre({ fetch: successfulFetch(config) });

    assert.deepEqual(run.fetches, [
      "https://cfstore.rethinkdns.com/blocklists/2026/bc/9-2/u6/basicconfig.json",
      "https://cfstore.rethinkdns.com/blocklists/2026/1788910929265/u6/filetag.json",
    ]);
    assert.deepEqual(run.writes, [
      { path: basicConfigPath, data: config },
      { path: filetagPath, data: '{"tags":[]}' },
    ]);
    assert.equal(run.exitCode, undefined);
  }
);

Deno.test(
  "falls back to field eight when field nine has no timestamp path",
  async () => {
    const config = "a,b,c,d,e,f,g,updated:2026/1788910929265,version:123";
    const run = await runPre({ fetch: successfulFetch(config) });

    assert.equal(
      run.fetches[1],
      "https://cfstore.rethinkdns.com/blocklists/2026/1788910929265/u6/filetag.json"
    );
    assert.match(run.logs.join("\n"), /filetag at f8/);
    assert.equal(run.exitCode, undefined);
  }
);

Deno.test(
  "retries five week candidates and exits after network failures",
  async () => {
    const run = await runPre({
      fetch: () => new Error("network unavailable"),
    });

    assert.equal(run.fetches.length, 5);
    assert.ok(run.fetches.every((url) => url.endsWith("/basicconfig.json")));
    assert.deepEqual(run.writes, []);
    assert.equal(run.exitCode, 1);
    assert.match(run.logs.join("\n"), /fetch error/);
  }
);

Deno.test(
  "malformed basic configuration never triggers a filetag request",
  async () => {
    const run = await runPre({
      fetch: () => new Response("too,few,fields"),
    });

    assert.equal(run.fetches.length, 5);
    assert.ok(run.fetches.every((url) => url.endsWith("/basicconfig.json")));
    assert.equal(run.exitCode, 1);
    assert.match(run.logs.join("\n"), /no filetag found/);
  }
);

Deno.test(
  "removes incomplete downloads when the filetag request fails",
  async () => {
    const config = "a,b,c,d,e,f,g,h,updated:2026/1788910929265";
    const run = await runPre({
      fetch: (url) =>
        url.endsWith("/basicconfig.json")
          ? new Response(config)
          : new Response(null, { status: 404 }),
    });

    assert.equal(run.fetches.length, 10);
    assert.equal(
      run.removes.filter((path) => path === basicConfigPath).length,
      5
    );
    assert.equal(run.removes.filter((path) => path === filetagPath).length, 5);
    assert.equal(run.exitCode, 1);
  }
);

Deno.test("week fallback crosses the January year boundary", async () => {
  const run = await runPre({
    now: "2027-01-01T00:00:00Z",
    fetch: () => new Response(null, { status: 404 }),
  });

  assert.deepEqual(run.fetches.slice(0, 2), [
    "https://cfstore.rethinkdns.com/blocklists/2027/bc/1-1/u6/basicconfig.json",
    "https://cfstore.rethinkdns.com/blocklists/2026/bc/12-5/u6/basicconfig.json",
  ]);
  assert.equal(run.exitCode, 1);
});
