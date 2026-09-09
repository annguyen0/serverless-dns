/**
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { deepStrictEqual, equal, match } from "node:assert/strict";

const preModule = new URL("./pre.ts", import.meta.url).href;
const basicPath = "./src/u6-basicconfig.json";
const filetagPath = "./src/u6-filetag.json";

type Reply = {
  body?: string;
  status?: number;
} | Error;

interface Scenario {
  existingFiles?: Record<string, string>;
  now?: string;
  replies?: Reply[];
}

interface Result {
  exitCodes: number[];
  files: Map<string, string>;
  logs: string[];
  reads: string[];
  removes: string[];
  requests: string[];
  stats: string[];
  writes: Array<[string, string]>;
}

let scenarioId = 0;

async function runPre({
  existingFiles = {},
  now = "2026-09-09T12:00:00Z",
  replies = [],
}: Scenario = {}): Promise<Result> {
  const files = new Map(Object.entries(existingFiles));
  const pendingReplies = [...replies];
  const result: Result = {
    exitCodes: [],
    files,
    logs: [],
    reads: [],
    removes: [],
    requests: [],
    stats: [],
    writes: [],
  };

  const original = {
    error: console.error,
    exit: Deno.exit,
    fetch: globalThis.fetch,
    log: console.log,
    now: Date.now,
    readTextFile: Deno.readTextFile,
    remove: Deno.remove,
    stat: Deno.stat,
    writeTextFile: Deno.writeTextFile,
  };

  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const deno = Deno as unknown as Record<string, unknown>;

  try {
    Date.now = () => new Date(now).getTime();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      result.requests.push(url);
      const reply = pendingReplies.shift();
      if (reply === undefined) {
        throw new Error(`No mocked response for ${url}`);
      }
      if (reply instanceof Error) {
        throw reply;
      }
      return new Response(reply.body ?? "", { status: reply.status ?? 200 });
    }) as typeof fetch;

    deno.stat = async (path: string | URL) => {
      const name = path.toString();
      result.stats.push(name);
      if (!files.has(name)) {
        throw new Deno.errors.NotFound();
      }
      return {} as Deno.FileInfo;
    };
    deno.readTextFile = async (path: string | URL) => {
      const name = path.toString();
      result.reads.push(name);
      const content = files.get(name);
      if (content === undefined) {
        throw new Deno.errors.NotFound();
      }
      return content;
    };
    deno.writeTextFile = async (path: string | URL, data: string) => {
      const name = path.toString();
      result.writes.push([name, data]);
      files.set(name, data);
    };
    deno.remove = async (path: string | URL) => {
      const name = path.toString();
      result.removes.push(name);
      if (!files.delete(name)) {
        throw new Deno.errors.NotFound();
      }
    };
    deno.exit = ((code = 0) => {
      result.exitCodes.push(code);
      finish();
      return undefined as never;
    }) as typeof Deno.exit;

    console.log = (...args: unknown[]) => {
      const message = args.map(String).join(" ");
      result.logs.push(message);
      if (
        message.includes("pre.ts: success") ||
        message.includes("pre.ts: no op") ||
        message.includes("pre.ts: all tries failed")
      ) {
        finish();
      }
    };
    console.error = (...args: unknown[]) => {
      result.logs.push(args.map(String).join(" "));
      finish();
    };

    await import(`${preModule}?scenario=${scenarioId++}`);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      finished,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("pre.ts did not finish within one second")),
          1_000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
  } finally {
    Date.now = original.now;
    globalThis.fetch = original.fetch;
    deno.stat = original.stat;
    deno.readTextFile = original.readTextFile;
    deno.writeTextFile = original.writeTextFile;
    deno.remove = original.remove;
    deno.exit = original.exit;
    console.log = original.log;
    console.error = original.error;
  }

  return result;
}

function basicConfigWithTimestamp(
  timestamp: string,
  field: 8 | 9 = 9,
): string {
  const fields = Array.from(
    { length: 9 },
    (_, index) => `"field${index + 1}":0`,
  );
  fields[field - 1] = `"timestamp":"${timestamp}"`;
  return `{${fields.join(",")}}`;
}

Deno.test("prepare skips downloads only when both generated files exist", async () => {
  const result = await runPre({
    existingFiles: {
      [basicPath]: "basic",
      [filetagPath]: "filetag",
    },
  });

  deepStrictEqual(result.stats, [basicPath, filetagPath]);
  deepStrictEqual(result.requests, []);
  deepStrictEqual(result.writes, []);
  deepStrictEqual(result.exitCodes, []);
});

Deno.test("prepare repairs a missing filetag instead of treating partial output as complete", async () => {
  const config = basicConfigWithTimestamp("2026/09/07");
  const result = await runPre({
    existingFiles: { [basicPath]: "stale basic config" },
    replies: [
      { body: config },
      { body: "fresh filetag" },
    ],
  });

  deepStrictEqual(result.requests, [
    "https://cfstore.rethinkdns.com/blocklists/2026/bc/9-2/u6/basicconfig.json",
    "https://cfstore.rethinkdns.com/blocklists/2026/09/07/u6/filetag.json",
  ]);
  equal(result.files.get(basicPath), config);
  equal(result.files.get(filetagPath), "fresh filetag");
  deepStrictEqual(result.exitCodes, []);
});

Deno.test("prepare downloads both files using a field-nine timestamp", async () => {
  const config = basicConfigWithTimestamp("2026/09/07", 9);
  const result = await runPre({
    replies: [
      { body: config },
      { body: "filetag contents" },
    ],
  });

  deepStrictEqual(result.requests, [
    "https://cfstore.rethinkdns.com/blocklists/2026/bc/9-2/u6/basicconfig.json",
    "https://cfstore.rethinkdns.com/blocklists/2026/09/07/u6/filetag.json",
  ]);
  deepStrictEqual(result.writes, [
    [basicPath, config],
    [filetagPath, "filetag contents"],
  ]);
  deepStrictEqual(result.exitCodes, []);
});

Deno.test("prepare falls back to the field-eight timestamp", async () => {
  const config = basicConfigWithTimestamp("2026/09/01", 8);
  const result = await runPre({
    replies: [
      { body: config },
      { body: "fallback filetag" },
    ],
  });

  equal(
    result.requests[1],
    "https://cfstore.rethinkdns.com/blocklists/2026/09/01/u6/filetag.json",
  );
  equal(result.files.get(filetagPath), "fallback filetag");
  equal(result.logs.some((line) => line.includes("filetag at f8")), true);
});

Deno.test("prepare retries the previous week after a fetch exception", async () => {
  const config = basicConfigWithTimestamp("2026/09/01");
  const result = await runPre({
    replies: [
      new TypeError("network unavailable"),
      { body: config },
      { body: "filetag" },
    ],
  });

  deepStrictEqual(result.requests, [
    "https://cfstore.rethinkdns.com/blocklists/2026/bc/9-2/u6/basicconfig.json",
    "https://cfstore.rethinkdns.com/blocklists/2026/bc/9-1/u6/basicconfig.json",
    "https://cfstore.rethinkdns.com/blocklists/2026/09/01/u6/filetag.json",
  ]);
  equal(
    result.logs.some((line) =>
      line.includes("fetch error") && line.includes("network unavailable")
    ),
    true,
  );
  deepStrictEqual(result.exitCodes, []);
});

Deno.test("prepare removes partial files and retries when the filetag download fails", async () => {
  const firstConfig = basicConfigWithTimestamp("2026/09/07");
  const secondConfig = basicConfigWithTimestamp("2026/09/01");
  const result = await runPre({
    replies: [
      { body: firstConfig },
      { status: 404 },
      { body: secondConfig },
      { body: "recovered filetag" },
    ],
  });

  deepStrictEqual(result.removes, [basicPath, filetagPath]);
  equal(result.files.get(basicPath), secondConfig);
  equal(result.files.get(filetagPath), "recovered filetag");
  equal(result.requests.length, 4);
  deepStrictEqual(result.exitCodes, []);
});

Deno.test("prepare rolls January week one back into the previous year", async () => {
  const config = basicConfigWithTimestamp("2025/12/29");
  const result = await runPre({
    now: "2026-01-01T00:00:00Z",
    replies: [
      { status: 404 },
      { body: config },
      { body: "year-boundary filetag" },
    ],
  });

  deepStrictEqual(result.requests, [
    "https://cfstore.rethinkdns.com/blocklists/2026/bc/1-1/u6/basicconfig.json",
    "https://cfstore.rethinkdns.com/blocklists/2025/bc/12-5/u6/basicconfig.json",
    "https://cfstore.rethinkdns.com/blocklists/2025/12/29/u6/filetag.json",
  ]);
  equal(result.files.get(filetagPath), "year-boundary filetag");
  deepStrictEqual(result.exitCodes, []);
});

Deno.test("prepare exits after five unsuccessful attempts", async () => {
  const result = await runPre({
    replies: Array.from({ length: 5 }, () => ({ status: 503 })),
  });

  equal(result.requests.length, 5);
  equal(
    result.requests.every((url) => url.endsWith("/u6/basicconfig.json")),
    true,
  );
  deepStrictEqual(result.writes, []);
  deepStrictEqual(result.exitCodes, [1]);
  match(result.logs.at(-1) ?? "", /all tries failed/);
});

Deno.test("prepare never requests a filetag when the config has no timestamp", async () => {
  const result = await runPre({
    replies: Array.from({ length: 5 }, () => ({ body: '{"invalid":true}' })),
  });

  equal(result.requests.length, 5);
  equal(
    result.requests.every((url) => url.endsWith("/u6/basicconfig.json")),
    true,
  );
  deepStrictEqual(result.exitCodes, [1]);
  equal(
    result.logs.filter((line) => line.includes("no filetag found")).length,
    5,
  );
});
