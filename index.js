/**
 * Gets gauges from osmosis/incentives/v1beta1/gauges
 * and compares with a local copy of previous API call.
 */

import fetch from "node-fetch";
import fs from "fs";
import jsondiffpatch from "jsondiffpatch";
import { ConsoleLogColors } from "js-console-log-colors";
import config from "./config/config.js";
const out = new ConsoleLogColors();
out.command("Fetch gauges from Osmosis API and watch changes...");

(async () => {
  if (config.DEBUG) {
    out.debug(
      "config.DEBUG == true; All debugger messages will be shown & console will be preserved."
    );
  } else {
    console.clear();
  }
  try {
    // 1. Fetch Gauges... This also overwrites the "gauges.json" file.
    out.command("1. Get new gauges");
    const gauges = await fetchGauges();
    if (!gauges?.data) {
      out.error("gauges.json is empty");
      if (config.BEHAVIOR.IGNORE_EMPTY_DATA) {
        if (config.DEBUG) {
          out.debug(
            "config.BEHAVIOR.IGNORE_EMPTY_DATA == true ... continuing!"
          );
        }
      } else {
        process.exit(0);
      }
    }

    // 2. Get old gauges from gauges-old.json file
    out.command("2. Get old gauges");
    const oldGauges = await getOldGaugesFromCache();
    if (!oldGauges?.data) {
      out.error("gauges-old.json is empty.");

      save_oldGauges();
      out.info("Old and new files are the same! Exiting...");
      process.exit(0);
    }

    // 3. map to nested object with gaugeID as key (new "indexed" json file)
    const indexedGauges = {};
    // build object
    gauges.data.forEach((gauge) => {
      indexedGauges[gauge.id] = gauge;
    });
    // save json file
    save_indexedGauges(indexedGauges);

    // 4. get previously cached indexed file and compare each gauge
    const oldIndexedGauges = get_oldIndexedGauges();
    const addedGauges = []; // array for any gauges that were added
    const deltas = {};
    for (const id in indexedGauges) {
      // for every gauge, compare by id with old gauges...
      const gauge = indexedGauges[id];
      // if guage id doesn't exist in old gauges, we know it's new!
      if (!oldIndexedGauges[id]) {
        addedGauges.push(id);
      }
      // at this point in the loop, old gauge exists for this gauge id.
      const oldGauge = oldIndexedGauges[id] || {};
      // Lets compare and get deltas:
      const delta = jsondiffpatch.diff(oldGauge, gauge);
      if (delta) {
        deltas[id] = delta;
      }
    }
    if (config.DELTAS.SEND_TO_STDOUT) {
      out.debug("delta preview:");
      console.log(deltas);
    }

    if (config.DELTAS.SEND_TO_FILE) {
      overwriteDeltasFile(deltas);
    }

    // 4. business logic from deltas
    out.command("4. process deltas");
    const arrNotableEvents = processDeltas(deltas, indexedGauges);
    overwriteNotableEventsFile({ data: arrNotableEvents });

    // 7. overwrite old indexed gauges with new one
    save_oldIndexedGauges();

    /* EVERYTHING BELOW THIS LINE IS OLD AND NEEDS TO BE REFACTORED AND MOVED ABOVE */
    /*
    


    // 5. overwrite old gauges with new gauges

    save_oldGauges();
    */
  } catch (error) {
    out.error(error);
  }
})();

function isRateLimitCheckOk() {
  if (config.DEBUG) {
    out.debug("called function: isRateLimitCheckOk()");
  }
  try {
    const stats = fs.statSync("./cache/gauges.json");
    let ageInSeconds = (Date.now() - stats.mtime.getTime()) / 1000;
    return ageInSeconds > config.API_QUERY.RATE_LIMIT_SECONDS;
  } catch (error) {
    out.error(error);
    return true;
  }
}

/**
 * fetch json data from remote API
 * @returns data [object]
 */
async function fetchGauges() {
  if (config.DEBUG) {
    out.debug("called function: fetchGauges()");
  }

  // data object to populate, write, and return...
  let data = {};

  // 1. check rate limit and exit if not ready
  out.command("Checking local cache (rate limit check)...");
  if (isRateLimitCheckOk()) {
    out.success("Rate limit ok.");
    out.command("Fetch gauges...");
  } else {
    out.warn(
      `Rate limit exceeded. Please wait ${config.RATE_LIMIT_SECONDS} seconds before trying again, or change the RATE_LIMIT_SECONDS in the config.json`
    );
    process.exit(0);
  }

  // 2. Fetch data from API (or local cache if debug setting)
  if (config.BEHAVIOR.SKIP_API_FETCH_GET_CACHED) {
    if (config.DEBUG) {
      out.debug(
        "config.BEHAVIOR.SKIP_API_FETCH_GET_CACHED == true ... not fetching gauges from API!"
      );
    }
    data = getNewGaugesFromCache();
  } else {
    out.info("Fetching new data from API (this may take a moment)...");
    data = await fetch(`${config.API_QUERY.URL}`).then((res) => res.json());
    out.success("Data fetched from API!");
  }

  // before we save the new gauges, lets update the "old" gauges to show the previous "new" gauges...
  save_oldGauges();
  save_oldIndexedGauges();

  // 3. Write to file: gauges.json
  if (config.BEHAVIOR.SKIP_SAVE_GAUGES) {
    if (config.DEBUG) {
      out.debug(
        "config.BEHAVIOR.SKIP_SAVE_GAUGES == true ... not saving gauges.json!"
      );
    }
  } else {
    out.command("Caching locally...");
    try {
      fs.writeFileSync("./cache/gauges.json", JSON.stringify(data));
      out.success("Cache updated!");
    } catch (err) {
      out.error("Unable to save gauges.json:");
      out.error(err.message);
      return;
    }
  }

  return data;
}

function save_indexedGauges(indexedGauges) {
  if (config.DEBUG) {
    out.debug("called function: save_indexedGauges()");
  }
  if (config.BEHAVIOR.SKIP_SAVE_INDEXED_FILE) {
    if (config.DEBUG) {
      out.debug(
        "config.BEHAVIOR.SKIP_SAVE_INDEXED_FILE == true ... not saving indexed-gauges.json!"
      );
    }
  } else {
    out.command("Caching indexed-gauges locally...");
    try {
      fs.writeFileSync(
        "./cache/indexed-gauges.json",
        JSON.stringify(indexedGauges)
      );
      out.success("./cache/indexed-gauges.json saved!");
    } catch (err) {
      out.error("Unable to save indexed-gauges.json:");
      out.error(err.message);
      return;
    }
  }
}

function save_oldIndexedGauges() {
  if (config.DEBUG) {
    out.debug("called function: save_oldIndexedGauges()");
  }
  if (config.BEHAVIOR.SKIP_SAVE_OLD_INDEXED_GAUGES) {
    if (config.DEBUG) {
      out.debug(
        "config.BEHAVIOR.SKIP_SAVE_OLD_INDEXED_GAUGES == true ... not saving indexed-gauges-old.json!"
      );
    }
  } else {
    out.command("Caching indexed-gauges-old locally...");
    try {
      fs.copyFileSync(
        "./cache/indexed-gauges.json",
        "./cache/indexed-gauges-old.json"
      );
      out.success("./cache/indexed-gauges-old.json saved!");
    } catch (err) {
      out.error("Unable to save indexed-gauges-old.json:");
      out.error(err.message);
      return;
    }
  }
}

function get_oldIndexedGauges() {
  if (config.DEBUG) {
    out.debug("called function: get_oldIndexedGauges()");
  }
  try {
    let fileContent = fs.readFileSync("./cache/indexed-gauges-old.json");
    return JSON.parse(fileContent);
  } catch (err) {
    out.error(err);
    return {};
  }
}

async function getOldGaugesFromCache() {
  if (config.DEBUG) {
    out.debug("called function: getOldGaugesFromCache()");
  }
  try {
    let fileContent = fs.readFileSync("./cache/gauges-old.json");
    return JSON.parse(fileContent);
  } catch (err) {
    out.error(err);
  }
}

function getNewGaugesFromCache() {
  if (config.DEBUG) {
    out.debug("called function: getNewGaugesFromCache()");
  }
  try {
    let fileContent = fs.readFileSync("./cache/gauges.json");
    return JSON.parse(fileContent);
  } catch (err) {
    out.error(err);
  }
}

function save_oldGauges() {
  if (config.DEBUG) {
    out.debug("called function: save_oldGauges()");
  }
  if (config.BEHAVIOR.SKIP_SAVE_OLD_GAUGES) {
    if (config.DEBUG) {
      out.debug(
        "config.BEHAVIOR.SKIP_SAVE_OLD_GAUGES == true ... not saving gauges-old.json!"
      );
    }
  } else {
    out.command("Overwrite gauges-old.json with gauges.json");
    try {
      fs.copyFileSync("./cache/gauges.json", "./cache/gauges-old.json");
      out.success("gauges-old.json overwritten with new file.");
      return true;
    } catch (err) {
      out.error("Error updating file gauges-old.json");
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
 * Extracts useful insights from gauges deltas. Arguments are both guage id indexed json objects
 * @param {*} indexedDeltas gauge-id indexed deltas json object
 * @param {*} indexedGauges latest indexed-gauges.json. Used for cross referencing.
 */
function processDeltas(indexedDeltas, indexedGauges) {
  if (config.DEBUG) {
    out.debug("called function: processDeltas()");
  }

  const arrNotableEvents = []; // build this array with notableEvent objects

  for (const idx in indexedDeltas) {
    if (idx !== "_t") {
      const delta = indexedDeltas[idx];

      // cross reference the gauge by array index
      const gauge = indexedGauges[idx];

      if (delta.filled_epochs) {
        // check if gauge is nearing expiration
        const res = gauge_isNearExpiration(gauge, delta.filled_epochs);
        if (res) {
          arrNotableEvents.push(res);
        }
      }

      const res = gauge_isNew(delta);
      if (res) {
        arrNotableEvents.push(res);
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
    const bondDurationDays = gauge.distribute_to.duration.slice(0, -1) / 86400;
    const remainingDays = gauge.num_epochs_paid_over - gauge.filled_epochs;
    if (bondDurationDays == remainingDays) {
      return {
        event: "NEAR_EXPIRATION",
        bondDurationDays: bondDurationDays,
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

      const bondDurationDays = gauge.distribute_to[0].duration.slice(0, -1) / 86400;
      const remainingDays = gauge.num_epochs_paid_over - gauge.filled_epochs;

      return {
        event: "NEW_GAUGE",
        bondDurationDays: bondDurationDays,
        remainingDays: remainingDays,
        startsInDays: daysUntilTimestamp.toFixed(0),
        gauge: gauge,
      };
    }
    return;
  } catch (error) {
    out.error(error);
    console.log(gauge);
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
