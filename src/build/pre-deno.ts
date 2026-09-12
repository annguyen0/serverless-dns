/*
 * Copyright (c) 2026 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// Deno-native equivalent of `src/build/pre.sh` (the shell version relies on
// `wget`, which is not available in the Deno Deploy build environment; only
// deno, node, npm, npx, yarn, pnpm, git, tar, gzip are).
//
// Fetches the latest blocklist `basicconfig.json` and `filetag.json` into
// `src/`, which `src/core/cfg.js` imports at module-load time. Usage:
//   deno task prepare-deno
//   deno run --allow-net --allow-write src/build/pre-deno.ts

const burl = "https://cfstore.rethinkdns.com/blocklists";
const dir = "bc";
const codec = "u6";
const basicConfigName = "basicconfig.json";
const fileTagName = "filetag.json";

const srcDir = `${Deno.cwd()}/src`;
const outBasic = `${srcDir}/${codec}-${basicConfigName}`;
const outFiletag = `${srcDir}/${codec}-${fileTagName}`;

// Full snapshots are committed to the repo (see .gitignore) so that
// `src/core/cfg.js` can never fail to import them at module-load on any
// runtime. On Deno Deploy builds we *always* re-fetch, so the committed
// snapshots don't go stale every time the app is redeployed.
const forceRefresh = Deno.env.get("DENO_DEPLOY") === "true";

async function exists(p: string): Promise<boolean> {
  try {
    const st = await Deno.stat(p);
    return st.isFile;
  } catch {
    return false;
  }
}

// mirrors the shell script's week calc: week is ceil(day / 7) per month
function weekDefaults(): { yyyy: number; mm: number; wk: number } {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = d.getMonth() + 1;
  const day = d.getDate();
  const wk = Math.ceil(day / 7);
  return { yyyy, mm, wk };
}

// basicconfig.json carries a timestamp like "2026/1788910929265"
function timestampFrom(text: string): string | null {
  const m = text.match(/"timestamp"\s*:\s*"([0-9]+\/[0-9]+)"/);
  return m ? m[1] : null;
}

async function writeIfOk(url: string, path: string): Promise<boolean> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    console.log("pre-deno: not ok", resp.status, url);
    return false;
  }
  await Deno.writeTextFile(path, await resp.text());
  console.log("pre-deno: wrote", path);
  return true;
}

// if both files already exist, nothing to do (as with pre.sh)
// (unless we're on a Deno Deploy build, where we always refresh)
if (!forceRefresh && (await exists(outBasic)) && (await exists(outFiletag))) {
  console.log("pre-deno: no-op, both files present", outBasic, outFiletag);
  Deno.exit(0);
}

const { yyyy: y0, mm: m0, wk: w0 } = weekDefaults();
let yyyy = y0;
let mm = m0;
let wk = w0;

// 0..4 (5 tries), stepping back one week at a time like pre.sh
for (let i = 0; i <= 4; i++) {
  // on Deno Deploy, overwrite the committed snapshot with the latest config
  if (!forceRefresh && (await exists(outBasic))) {
    console.log("pre-deno: no-op, basicconfig present", outBasic);
    Deno.exit(0);
  }

  const basicUrl = `${burl}/${yyyy}/${dir}/${mm}-${wk}/${codec}/${basicConfigName}`;
  console.log(`pre-deno: try ${i} ${basicUrl}`);
  try {
    const resp = await fetch(basicUrl, { redirect: "follow" });
    if (resp.ok) {
      const text = await resp.text();
      const ts = timestampFrom(text);
      if (ts) {
        await Deno.writeTextFile(outBasic, text);
        console.log("pre-deno: basicconfig ok", outBasic, "ts", ts);
        await writeIfOk(
          `${burl}/${ts}/${codec}/${fileTagName}`,
          outFiletag
        );
        Deno.exit(0);
      } else {
        console.error("pre-deno: no timestamp in", basicUrl);
      }
    } else {
      console.log("pre-deno: basicconfig not ok", resp.status, basicUrl);
    }
  } catch (e) {
    console.error("pre-deno: error", e);
  }

  // prev week; if wrapped past january, roll the year back
  wk -= 1;
  if (wk === 0) {
    wk = 5; // only feb has 28 days (28/7 => 4), edge-case overcome by retries
    mm -= 1;
  }
  if (mm === 0) {
    mm = 12;
    yyyy -= 1;
  }
}

console.error("pre-deno: could not fetch blocklist config");
Deno.exit(1);