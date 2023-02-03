/**
 * Gets external gauges from osmosis/pool-incentives/v1beta1/external_incentive_gauges
 * and compares with a local copy of previous API call.
 */

import fetch from "node-fetch";
import fs from "fs";
import fastJsonPatch from "fast-json-patch";
import { ConsoleLogColors } from "js-console-log-colors";
import config from "./config/config.js";
import { exit } from "process";

const out = new ConsoleLogColors();
out.command(
  "Fetch external incentive gauges from Osmosis API and watch changes..."
);

(async () => {
  if (config.DEBUG) {
    out.debug("config.DEBUG == true; All debugger messages will be shown & console will be preserved.")
  } else {
    console.clear();
  }
  try {
    // 1. Fetch Externals... This also overwrites the "externals.json" file.
    const externals = await fetchExternals();
    if (!externals?.data) {
      out.error("externals.json is empty");
      if (config.DEBUG && config.DEBUG_IGNORE_EMPTY_DATA) {
        out.debug("DEBUG_IGNORE_EMPTY_DATA == true ... continuing!");
      } else {
        process.exit(0);
      }
    }

    // 2. Get old externals from externals-old.json file
    const oldExternals = await getOldExternals();
    if (!oldExternals?.data) {
      out.error("externals-old.json is empty.");

      overwriteOldFileWithNewFile();
      out.info("Old and new files are the same! Exiting...");
      process.exit(0);
    }

    // 3. compare the old with the new:
    out.command("Compare old and new gauges");
    // const patch = fastJsonPatch.compare(oldExternals, externals);
    const patch = fastJsonPatch.compare(oldExternals, externals);

    if (config.DEBUG && config.DEBUG_PREVIEW_CHANGELOG) {
      out.debug("patch preview:");
      console.log(patch);
    }

    if (config.SAVE_CHANGELOG_FILE) {
      overwriteChangelogFile({ data: patch });
    }

    // 4. overwrite old externals with new externals

    overwriteOldFileWithNewFile();
  } catch (error) {
    out.error(error);
  }
})();

function isRateLimitCheckOk() {
  if (config.DEBUG) {
    out.debug("called function: isRateLimitCheckOk()");
  }
  try {
    const stats = fs.statSync("./cache/externals.json");
    let ageInSeconds = (Date.now() - stats.mtime.getTime()) / 1000;
    return ageInSeconds > config.RATE_LIMIT_SECONDS;
  } catch (error) {
    out.error(error);
    return true;
  }
}

/**
 * fetch json data from remote API
 * @returns data [object]
 */
async function fetchExternals() {
  if (config.DEBUG) {
    out.debug("called function: fetchExternals()");
  }

  // data object to populate, write, and return...
  let data = {};

  // 1. check rate limit and exit if not ready
  out.command("Checking local cache (rate limit check)...");
  if (isRateLimitCheckOk()) {
    out.info("Rate limit ok.");
    out.command("Fetch external gauges...");
  } else {
    out.info(
      `Rate limit exceeded. Please wait ${config.RATE_LIMIT_SECONDS} seconds before trying again, or change the RATE_LIMIT_SECONDS in the config.json`
    );
    process.exit(0);
  }

  // 2. Fetch data from API
  if (config.DEBUG && config.DEBUG_SKIP_API_FETCH) {
    out.debug("DEBUG_SKIP_API_FETCH == true ... not fetching gauges from API!");
  } else {
    out.info("Fetching new data from API (this may take a moment)...");
    data = await fetch(`${config.API_QUERY_URL}`).then((res) => res.json());
    out.success("Data fetched from API!");
  }

  // 3. Write to file: externals.json
  if (config.DEBUG && config.DEBUG_SKIP_SAVE_NEW_FILE) {
    out.debug(
      "DEBUG_SKIP_SAVE_NEW_FILE == true ... not saving externals.json!"
    );
  } else {
    out.command("Caching locally...");
    try {
      fs.writeFileSync("./cache/externals.json", JSON.stringify(data));
      out.success("Cache updated!");
    } catch (err) {
      out.error("Unable to save externals.json:");
      out.error(err.message);
      return;
    }
  }

  return data;
}

async function getOldExternals() {
  if (config.DEBUG) {
    out.debug("called function: getOldExternals()");
  }
  try {
    let fileContent = fs.readFileSync("./cache/externals-old.json");
    return JSON.parse(fileContent);
  } catch (err) {
    out.error(err);
  }
}

function overwriteOldFileWithNewFile() {
  if (config.DEBUG) {
    out.debug("called function: overwriteOldFileWithNewFile()");
  }
  if (config.DEBUG && config.DEBUG_SKIP_SAVE_OLD_FILE) {
    out.debug(
      "DEBUG_SKIP_SAVE_OLD_FILE == true ... not saving externals-old.json!"
    );
  } else {
    out.command("Overwrite externals-old.json with externals.json");
    try {
      fs.copyFileSync("./cache/externals.json", "./cache/externals-old.json");
      out.success("externals-old.json overwritten with new file.");
      return true;
    } catch (err) {
      out.error("Error updating file externals-old.json");
      out.error(err);
      return false;
    }
  }
}

function overwriteChangelogFile(data) {
  if (config.DEBUG) {
    out.debug("called function: saveLatestChangesLog()");
  }
  out.command("Saving changelog.json");
  try {
    fs.writeFileSync("./logs/changelog.json", JSON.stringify(data));
    out.success("Changelog updated!");
  } catch (err) {
    out.error("Unable to save changelog.json:");
    out.error(err.message);
    return;
  }
}

// function saveState({  }){
//   fs.writeFile("state.json", JSON.stringify(json), (err) => {
//     if (err) {
//       console.error(err);
//       return;
//     }
//     console.log("Saved to local file...");
//   });
// }

(() => {
  function cleanUp(eventType) {
    out.warn(eventType);
    if (eventType == "exit") {
      if (config.DEBUG) {
        console.log("");
        console.log("");
        console.log("");
        console.log("");
      }
    } else {
      process.exit(0);
    }
  }
  [
    `exit`,
    `SIGINT`,
    `SIGUSR1`,
    `SIGUSR2`,
    `uncaughtException`,
    `SIGTERM`,
  ].forEach((eventType) => {
    process.on(eventType, cleanUp.bind(null, eventType));
  });
})();
