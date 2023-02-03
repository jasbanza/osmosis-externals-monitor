/**
 * Gets external gauges from osmosis/pool-incentives/v1beta1/external_incentive_gauges
 * and compares with a local copy of previous API call.
 */

import fetch from "node-fetch";
import fs from "fs";
import jsondiffpatch from "jsondiffpatch";
import { ConsoleLogColors } from "js-console-log-colors";
import config from "./config/config.js";
import { exit } from "process";
import { clear } from "console";
const out = new ConsoleLogColors();
out.command(
  "Fetch external incentive gauges from Osmosis API and watch changes..."
);

(async () => {
  if (config.DEBUG) {
    out.debug(
      "config.DEBUG == true; All debugger messages will be shown & console will be preserved."
    );
  } else {
    console.clear();
  }
  try {
    // 1. Fetch Externals... This also overwrites the "externals.json" file.
    out.command("1. Get new gauges");
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
    out.command("2. Get old gauges");
    const oldExternals = await getOldExternalsFromCache();
    if (!oldExternals?.data) {
      out.error("externals-old.json is empty.");

      overwriteOldFileWithNewFile();
      out.info("Old and new files are the same! Exiting...");
      process.exit(0);
    }

    // 3. calculate the deltas:
    out.command("3. Get deltas");
    const deltas = jsondiffpatch.diff(oldExternals, externals) || {};

    if (config.DEBUG && config.DEBUG_PREVIEW_DELTAS) {
      out.debug("delta preview:");
      console.log(deltas);
    }

    if (config.SAVE_DELTAS_FILE) {
      overwriteDeltasFile(deltas);
    }

    // 4. business logic from deltas
    out.command("4. process deltas");
    const arrNotableEvents = processDeltas(deltas, externals);
    overwriteNotableEventsFile({ data: arrNotableEvents });

    // 5. overwrite old externals with new externals

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

  // 2. Fetch data from API (or local cache if debug setting)
  if (config.DEBUG && config.DEBUG_SKIP_API_FETCH_GET_CACHED) {
    out.debug(
      "DEBUG_SKIP_API_FETCH_GET_CACHED == true ... not fetching gauges from API!"
    );
    data = getNewExternalsFromCache();
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

async function getOldExternalsFromCache() {
  if (config.DEBUG) {
    out.debug("called function: getOldExternalsFromCache()");
  }
  try {
    let fileContent = fs.readFileSync("./cache/externals-old.json");
    return JSON.parse(fileContent);
  } catch (err) {
    out.error(err);
  }
}

async function getNewExternalsFromCache() {
  if (config.DEBUG) {
    out.debug("called function: getNewExternalsFromCache()");
  }
  try {
    let fileContent = fs.readFileSync("./cache/externals.json");
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

function overwriteDeltasFile(data) {
  if (config.DEBUG) {
    out.debug("called function: overwriteDeltasFile()");
  }
  out.command("Saving deltas.json");
  try {
    fs.writeFileSync("./cache/deltas.json", JSON.stringify(data));
    out.success("Deltas updated!");
  } catch (err) {
    out.error("Unable to save deltas.json:");
    out.error(err.message);
    return;
  }
}

function overwriteNotableEventsFile(data) {
  if (config.DEBUG) {
    out.debug("called function: overwriteNotableEventsFile()");
  }
  out.command("Saving notable-events.json");
  try {
    fs.writeFileSync("./cache/notable-events.json", JSON.stringify(data));
    out.success("Notable events updated!");
  } catch (err) {
    out.error("Unable to save notable-events.json:");
    out.error(err.message);
    return;
  }
}

/**
 * Extracts useful insights from external gauges deltas.
 * @param {*} jsondiffpatchDeltas raw deltas json received from jsondiffpatch.diff(oldExternals,externals)
 * @param {*} newData latest external gauges json. Used for cross referencing.
 */
function processDeltas(jsondiffpatchDeltas, newData) {
  if (config.DEBUG) {
    out.debug("called function: processDeltas()");
  }

  const deltas = jsondiffpatchDeltas?.data;
  const arrNotableEvents = []; // build this array with notableEvent objects

  // The gauge data is an array, and deltas is an object with each key being the index
  for (const idx in deltas) {
    if (idx !== "_t") {
      const delta = deltas[idx];

      if (delta?.id) continue; // ignore changes to a gauges "id" field - this should never change, so it would indicate corrupt data

      // cross reference the gauge by array index
      const gauge = newData.data[idx];

      if (delta.filled_epochs) {
        // check if gauge is nearing expiration
        const res = gauge_isNearExpiration(gauge, delta.filled_epochs);
        if (res) {
          arrNotableEvents.push(res);
        }
      }

      if (Array.isArray(delta)) {
        const res = gauge_isNew(delta[0]);
        if (res) {
          arrNotableEvents.push(res);
        }
      }
    }
  }
  return arrNotableEvents;
}

// BUSINESS LOGIC FUNCTIONS:

// TODO: implement config.NOTIFICATIONS

function gauge_isNearExpiration(gauge, filled_epochs) {
  try {
    if (gauge.is_perpetual) return false;
    const durationDays = gauge.distribute_to.duration.slice(0, -1) / 86400;
    const remainingDays = gauge.num_epochs_paid_over - gauge.filled_epochs;
    if (durationDays == remainingDays) {
      return {
        event: "NEAR_EXPIRATION",
        durationDays: durationDays,
        remainingDays: remainingDays,
        gauge: gauge,
      };
    }
  } catch (error) {
    out.error(error);
    return;
  }
}

function gauge_isNew(gauge) {
  try {
    // basic check
    if (gauge?.id) {
      const currentTime = new Date();
      const targetTime = new Date(gauge.start_time);

      const timeDifference = targetTime - currentTime;
      const daysUntilTimestamp = timeDifference / (1000 * 60 * 60 * 24);

      const durationDays = gauge.distribute_to.duration.slice(0, -1) / 86400;
      const remainingDays = gauge.num_epochs_paid_over - gauge.filled_epochs;

      return {
        event: "NEW_GAUGE",
        durationDays: durationDays,
        remainingDays: remainingDays,
        startsInDays: daysUntilTimestamp.toFixed(0),
        gauge: gauge,
      };
    }
    return;
  } catch (error) {
    out.error(error);
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
