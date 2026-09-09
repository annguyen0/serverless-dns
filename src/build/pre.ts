/**
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// Deno-native replacement for pre.sh
// Downloads blocklist configuration files using Deno.fetch()
// This works in Deno Deploy's build environment which may not have wget/curl

const burl = "https://cfstore.rethinkdns.com/blocklists";
const dir = "bc";
const codec = "u6";
const f = "basicconfig.json";
const f2 = "filetag.json";
const out = `"./src/${codec}-${f}"`;
const out2 = `"./src/${codec}-${f2}"`;

// Get current date info
const now = Date.now();
const date = new Date(now);
const yyyy = date.getUTCFullYear();
const mm = date.getUTCMonth() + 1; // Months are 0-indexed
const day = date.getUTCDate();

// Calculate week (ceiling of day/7)
let wk = Math.ceil(day / 7);

// Format as strings without leading zeros
const mmStr = mm.toString();
const wkStr = wk.toString();

/**
 * Downloads a text resource to `dest`.
 *
 * @returns `true` after the response is written, or `false` if the request,
 * response, or file write fails.
 */
async function downloadFile(url: string, dest: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      console.log(`==x= pre.ts: fetch failed ${url} status=${response.status}`);
      return false;
    }
    const data = await response.text();
    await Deno.writeTextFile(dest, data);
    console.log(`===x pre.ts: downloaded ${url} -> ${dest}`);
    return true;
  } catch (error) {
    console.log(`==x= pre.ts: fetch error ${url}:`, error);
    return false;
  }
}

function hasForwardSlash(s: string): boolean {
  return s.includes("/");
}

/**
 * Extracts the file-tag timestamp from a comma-delimited basic configuration.
 *
 * The ninth field is preferred; the eighth is used when the filtered ninth
 * field contains no forward slash.
 *
 * @returns The selected field stripped to digits and forward slashes, or
 * `null` when a required field or colon delimiter is absent.
 */
function extractTimestamp(content: string): string | null {
  // Mimic the shell script logic:
  // fulltimestamp=$(cut -d"," -f9 "$out" | cut -d":" -f2 | tr -dc '0-9/')
  // Split by comma, get field 9, split by colon, get field 2, keep only digits and /
  
  const fields = content.split(",");
  if (fields.length < 9) {
    return null;
  }
  
  // Get field 9 (0-indexed: 8)
  let field9 = fields[8];
  // Split by colon and get field 2 (0-indexed: 1)
  const colonParts = field9.split(":");
  if (colonParts.length < 2) {
    return null;
  }
  
  let timestamp = colonParts[1];
  // Keep only digits and /
  timestamp = timestamp.replace(/[^0-9/]/g, "");
  
  if (hasForwardSlash(timestamp)) {
    console.log(`==x= pre.ts: filetag at f9: ${timestamp}`);
    return timestamp;
  }
  
  // Try field 8 if field 9 doesn't have /
  console.log(`==x= pre.ts: filetag at f8`);
  let field8 = fields[7];
  const colonParts8 = field8.split(":");
  if (colonParts8.length < 2) {
    return null;
  }
  
  timestamp = colonParts8[1];
  timestamp = timestamp.replace(/[^0-9/]/g, "");
  
  return timestamp;
}

/**
 * Downloads a week bucket's basic configuration and its referenced file tag.
 *
 * @returns `true` only after both output files are written. A failed file-tag
 * download triggers best-effort removal of both files; other failures may
 * leave the basic configuration in place.
 */
async function tryDownload(yyyy: number, mm: number, wk: number): Promise<boolean> {
  const url = `${burl}/${yyyy}/${dir}/${mm}-${wk}/${codec}/${f}`;
  console.log(`x=== pre.ts: try ${yyyy}/${mm}-${wk}`);
  
  const success = await downloadFile(url, out);
  if (!success) {
    return false;
  }
  
  // Extract filetag from the downloaded file
  let fulltimestamp: string | null = null;
  try {
    const content = await Deno.readTextFile(out);
    fulltimestamp = extractTimestamp(content);
    
    if (fulltimestamp) {
      console.log(`==x= pre.ts: ok; filetag? ${fulltimestamp}`);
    }
  } catch (error) {
    console.log(`==x= pre.ts: error reading file:`, error);
    return false;
  }
  
  if (fulltimestamp) {
    const url2 = `${burl}/${fulltimestamp}/${codec}/${f2}`;
    const success2 = await downloadFile(url2, out2);
    if (success2) {
      console.log(`===x pre.ts: filetag ok`);
      return true;
    } else {
      console.log(`===x pre.ts: filetag not ok`);
      // Clean up
      try { await Deno.remove(out); } catch {}
      try { await Deno.remove(out2); } catch {}
      return false;
    }
  }
  
  console.log(`===x pre.ts: no filetag found`);
  return false;
}

/**
 * Prepares blocklist configuration files unless the basic configuration path
 * already exists.
 *
 * Tries at most five descending week buckets and exits with status 1 if none
 * succeeds.
 */
async function main() {
  // Check if files already exist
  try {
    const stat = await Deno.stat(out);
    console.log(`=x== pre.ts: no op ${out} already exists`);
    return;
  } catch {
    // File doesn't exist, continue
  }
  
  // Try current week, then previous weeks
  const maxTries = 5;
  
  for (let i = 0; i < maxTries; i++) {
    console.log(`x=== pre.ts: $i try ${yyyy}/${mmStr}-${wkStr}`);
    
    const success = await tryDownload(yyyy, mm, wk);
    if (success) {
      console.log(`===x pre.ts: success`);
      return;
    }
    
    // Try previous week
    wk--;
    if (wk === 0) {
      wk = 5; // Previous month (edge case)
    }
  }
  
  console.log("===x pre.ts: all tries failed");
  Deno.exit(1);
}

main().catch((error) => {
  console.error("===x pre.ts: fatal error:", error);
  Deno.exit(1);
});
