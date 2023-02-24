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

const startTime = Date.now();
let indexedPools = {}; // populate from cache or API later only if we need to.

(async () => {
  try {
    if (config.DEBUG) {
      out.debug(
        "config.DEBUG == true; All debugger messages will be shown & console will be preserved."
      );
    } else {
      console.clear();
      out.command("Fetch gauges from Osmosis API and watch changes...");
    }

    try {
      await initializeFiles();
    } catch (err) {
      out.error("Error calling initializeFiles():");
      out.error(err);
      process.exit(0);
    }

    // 1. Fetch Gauges... This also overwrites the "gauges.json" file.
    let gauges = {};
    try {
      gauges = await fetchGauges();
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
    } catch (err) {
      out.error("Error saving gauges:");
      out.error(err);
    }

    // 3. map to nested object with gaugeID as key (new "indexed" json file)
    const indexedGauges = {};
    try {
      // build object
      gauges.data.forEach((gauge) => {
        indexedGauges[gauge.id] = gauge;
      });
      // save json file
      save_indexedGauges(indexedGauges);
    } catch (err) {
      out.error("Error indexing gauges:");
      out.error(err);
    }

    // 4. get previously cached indexed file and compare each gauge
    const deltas = {};
    try {
      const oldIndexedGauges = get_oldIndexedGauges();
      const addedGauges = []; // array for any gauges that were added
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
    } catch (err) {
      out.error("Error creating deltas:");
      out.error(err);
    }

    // 4. process deltas and create notable events
    let arrNotableEvents = [];
    try {
      out.command("Process deltas...");
      arrNotableEvents = await processDeltas(deltas, indexedGauges);
      overwriteNotableEventsFile({ data: arrNotableEvents });
    } catch (err) {
      out.error("Error parsing deltas to notable events:");
      out.error(err);
    }

    // 7. overwrite old indexed gauges with new one
    try {
      save_oldIndexedGauges();
    } catch (err) {
      out.error("Error overwriting old indexed gauges with current one:");
      out.error(err);
    }

    // TELEGRAM NOTIFICATIONS
    try {
      if (config.TG_BOT.ACTIVE) {
        doTelegramNotifications(arrNotableEvents);
      }
    } catch (err) {
      out.error("Error processing Telegram notifications:");
      out.error(err);
    }
  } catch (err) {
    out.error("Error in main (IIFE):");
    out.error(err);
  }
})();

function isRateLimitCheckOk() {
  if (config.DEBUG) {
    out.debug("called function: isRateLimitCheckOk()");
  }
  try {
    const stats = fs.statSync("./cache/gauges.json");
    let ageInSeconds = (Date.now() - stats.mtime.getTime()) / 1000;
    return ageInSeconds > config.API.RATE_LIMIT_SECONDS;
  } catch (err) {
    out.error(err);
    return true;
  }
}

/**
 * fetch json data from remote API
 * @returns {{}}
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
  } else {
    out.warn(
      `Rate limit exceeded. Please wait ${config.API.RATE_LIMIT_SECONDS} seconds before trying again, or change the API.RATE_LIMIT_SECONDS in the config.json`
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
    data = await callAPI(
      "/osmosis/incentives/v1beta1/gauges?pagination.limit=9999"
    )
      .then((res) => res.json())
      .catch((err) => {
        out.error("unable to access API at this time.");
        process.exit(0);
      });
    out.success("Gauges data fetched from API!");
  }

  /* before we save the new gauges, lets update the "old" gauges to show the previous "new" gauges...
   logic: calling this both at the start AND end of the process -> you wont get reattempts if the process fails. 
   commenting it out would result in reattempts and possible duplicate notifications every time this script is run
   */
  save_oldIndexedGauges();

  // 3. Write to file: gauges.json
  if (config.BEHAVIOR.SKIP_SAVE_GAUGES) {
    if (config.DEBUG) {
      out.debug(
        "config.BEHAVIOR.SKIP_SAVE_GAUGES == true ... not saving gauges.json!"
      );
    }
  } else {
    out.command("save gauges...");
    try {
      fs.writeFileSync("./cache/gauges.json", JSON.stringify(data));
      out.success("... updated ./cache/gauges.json");
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
    out.command("save indexed-gauges...");
    try {
      fs.writeFileSync(
        "./cache/indexed-gauges.json",
        JSON.stringify(indexedGauges)
      );
      out.success("... updated ./cache/indexed-gauges.json");
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
    out.command("copy indexed-gauges > indexed-gauges-old ...");
    try {
      fs.copyFileSync(
        "./cache/indexed-gauges.json",
        "./cache/indexed-gauges-old.json"
      );
      out.success("... updated ./cache/indexed-gauges-old.json");
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
    out.error("Error in get_oldIndexedGauges():");
    out.error(err);
    return {};
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
    out.error("Error in getNewGaugesFromCache():");
    out.error(err);
  }
}

function overwriteDeltasFile(data) {
  if (config.DEBUG) {
    out.debug("called function: overwriteDeltasFile()");
  }
  // out.command("Saving deltas.json");
  try {
    fs.writeFileSync("./cache/deltas.json", JSON.stringify(data));
    out.success("... updated deltas");
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
  // out.command("Saving notable-events.json");
  try {
    fs.writeFileSync("./cache/notable-events.json", JSON.stringify(data));
    out.success("... updated notable events");
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
async function processDeltas(indexedDeltas, indexedGauges) {
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
        const res = await gauge_isNearExpiration(gauge, delta.filled_epochs);
        if (res) {
          arrNotableEvents.push(res);
        }
      }

      const res = await gauge_isNew(delta, indexedGauges);
      if (res) {
        arrNotableEvents.push(res);
      }
    }
  }
  return arrNotableEvents;
}

// BUSINESS LOGIC FUNCTIONS:

// TODO: implement config.NOTIFICATIONS

async function gauge_isNearExpiration(gauge, filled_epochs) {
  try {
    if (gauge.is_perpetual) return false;
    const bondDurationDays = gauge.distribute_to.duration.slice(0, -1) / 86400;
    const remainingDays = gauge.num_epochs_paid_over - gauge.filled_epochs;
    if (bondDurationDays == remainingDays) {
      const poolId = getPoolIdFromGauge(gauge);
      const poolInfo = await getPoolInfo(poolId);
      const coins = await getCoinsInfo(gauge.coins);
      return {
        type: "NEAR_EXPIRATION",
        poolId: poolId,
        poolAssetSymbols: poolInfo.poolAssetSymbols,
        coins: coins,
        bondDurationDays: bondDurationDays,
        remainingDays: remainingDays,
        gauge: gauge,
      };
    }
  } catch (err) {
    out.error("Error in gauge_isNearExpiration():");
    out.error(err);
    return;
  }
}

async function gauge_isNew(delta, indexedGauges) {
  try {
    // basic check
    if (delta?.id) {
      const gauge = indexedGauges[delta.id];
      const poolId = getPoolIdFromGauge(gauge);
      const poolInfo = await getPoolInfo(poolId);
      const coins = await getCoinsInfo(gauge.coins);
      const currentTime = new Date();
      const targetTime = new Date(gauge.start_time);

      const timeDifference = targetTime - currentTime;
      const daysUntilTimestamp = timeDifference / (1000 * 60 * 60 * 24);

      const bondDurationDays =
        gauge.distribute_to.duration.slice(0, -1) / 86400;
      const remainingDays = gauge.num_epochs_paid_over - gauge.filled_epochs;

      if (remainingDays >= 0) {
        // gaugeType
        let type = "NEW_EXTERNAL_GAUGE";

        // CHECK FOR NEW SUPERFLUID POOLS
        if (gauge.distribute_to?.denom?.includes("superbonding")) {
          // only if it is the first "superbonding" for the pool...
          for (const id in indexedGauges) {
            if (id !== gauge.id) {
              if (
                indexedGauges[id].distribute_to.denom.includes(
                  `/${poolId}/superbonding`
                )
              ) {
                return;
              }
            }
          }
          type = "NEW_SUPERFLUID_GAUGE";
        } else if (gauge.is_perpetual && gauge.coins[0]?.denom == "uosmo") {
          // new gauge AND it has internal incentives loaded (might never reach here due to governance requirement, but just in case)
          type = "NEW_INTERNAL_GAUGE";
        } else if (gauge.is_perpetual && !gauge.coins[0]) {
          // can ignore - placeholder (empty) gauge for internal incentives
          return;
        }
        return {
          type: type,
          poolId: poolId,
          coins: coins,
          poolAssetSymbols: poolInfo.poolAssetSymbols,
          bondDurationDays: bondDurationDays,
          remainingDays: remainingDays,
          startsInDays: daysUntilTimestamp.toFixed(0),
          gauge: gauge,
        };
      }
    }
    return;
  } catch (err) {
    out.error("Error in gauge_isNew():");
    out.error(err);
    return;
  }
}

function getPoolIdFromGauge(gauge) {
  try {
    const match = gauge.distribute_to.denom.match(/\d+/); // matches one or more digits
    return (match ? parseInt(match[0]) : NaN).toString(); // convert first matched digits to number
  } catch (err) {
    out.error("Error in getPoolIdFromGauge():");
    out.error(err);
    return NaN.toString();
  }
}

function doTelegramNotifications(arrNotableEvents) {
  if (config.DEBUG) {
    out.debug("called function: doTelegramNotifications()");
  }
  const arrTelegramNotifications = [];
  arrNotableEvents.forEach((event) => {
    let txt = null;
    switch (event.type) {
      case "NEAR_EXPIRATION":
        txt = `<i>⚠️ LP Incentives expiring soon!</i>`;
        txt += `\n\n🧪 Pool <b><a href="https://frontier.osmosis.zone/pool/${event.poolId}">${event.poolId} </a>(${event.poolAssetSymbols})</b>`;
        if (event.coins) {
          txt += `\n\nIncentives: `;
          for (const coin of event.coins) {
            if (event.coins.length > 1) {
              txt += `\n`;
            }
            if (coin.symbol.startsWith("ft") && coin.symbol.length > 2) {
              txt += `<b>Fan Token ${coin.symbol}</b>`;
            } else if (coin.symbol.startsWith("ibc")) {
              txt += `<b>${coin.symbol}</b>`;
            } else {
              txt += `<b>$${coin.symbol}</b>`;
            }
          }
          txt += `\n\n`;
        }

        txt += `\nUnbonding duration: <b>${event.bondDurationDays} days</b>`;
        txt += `\nRemaining rewards: <b>${event.remainingDays} days</b>`;
        break;

      case "NEW_EXTERNAL_GAUGE":
        txt = `<i>New External Incentives Added!</i>`;
        txt += `\n\n🧪 Pool <b><a href="https://frontier.osmosis.zone/pool/${event.poolId}">${event.poolId} </a>(${event.poolAssetSymbols})</b>`;
        txt += `\n⏳ Unbonding: <b>${event.bondDurationDays} days</b>`;
        if (event.coins) {
          txt += `\n\n💰 Rewards: `;
          for (const coin of event.coins) {
            if (event.coins.length > 1) {
              txt += `\n`;
            }

            if (coin.symbol.startsWith("ft") && coin.symbol.length > 2) {
              txt += `<b>${coin.amount / Math.pow(10, 6)} Fan Tokens (${
                coin.symbol
              })</b>`;
            } else if (coin.symbol.startsWith("ibc")) {
              txt += `<b>${coin.amount} ${coin.symbol}</b>`;
            } else {
              txt += `<b>${
                coin.exponent
                  ? coin.amount / Math.pow(10, coin.exponent)
                  : coin.amount
              } $${coin.symbol}</b>`;
            }
          }

          if (event.coins.length > 1) {
            txt += `\n - `;
          }
          txt += ` <i>over ${event.gauge.num_epochs_paid_over} days</i>`;
        }

        txt += `\n\n📆 Remaining: <b>${event.remainingDays} days</b>`;

        try {
          const timeUntilEpoch = timeUntilEpoch_fromStartTime(
            event.gauge.start_time
          );
          txt += `\n⏰ Next Distribution in: <b>${timeUntilEpoch}</b>`;
        } catch (err) {
          out.error(
            "Error calling timeUntilEpoch_fromStartTime() from doTelegramNotifications() [in switch case NEW_EXTERNAL_GAUGE]:"
          );
          out.error(err);
        }
        break;

      case "NEW_INTERNAL_GAUGE":
        txt = `<i>💰 New Internal (🧪 $OSMO) Incentives Added!</i>`;
        txt += `\n\n<b>Pool <a href="https://frontier.osmosis.zone/pool/${event.poolId}">${event.poolId} </a>(${event.poolAssetSymbols})</b>`;
        txt += `\nUnbonding duration: <b>${event.bondDurationDays} days</b>`;
        try {
          const timeUntilEpoch = timeUntilEpoch_fromStartTime(
            event.gauge.start_time
          );
          txt += `\nReward distribution in: <b>${timeUntilEpoch}</b>`;
        } catch (err) {
          out.error(
            "Error calling timeUntilEpoch_fromStartTime() from doTelegramNotifications() [in switch case NEW_INTERNAL_GAUGE]:"
          );
          out.error(err);
        }
        txt += `\nRemaining rewards: <b>${event.remainingDays} days</b>`;
        break;

      case "NEW_SUPERFLUID_GAUGE":
        txt = `<i>🌟 Superfluid Staking Enabled!</i>`;
        txt += `\n\nPool: <b><a href="https://frontier.osmosis.zone/pool/${event.poolId}">${event.poolId} </a>(${event.poolAssetSymbols})</b>`;
        break;
      default:
        break;
    }
    if (txt) {
      arrTelegramNotifications.push(txt);
    }
  });
  processTelegramNotifications(arrTelegramNotifications);
}

/**
 * Puts notifications into batches, and delays their sending.
 * @param {*} arrTelegramNotifications
 */
function processTelegramNotifications(arrTelegramNotifications) {
  // add 50ms between calls.
  // limit to 20 calls per minute.
  let arrBatches = [];
  let currentBatch = [];
  const totalNotifications = arrTelegramNotifications.length;

  // create batches
  for (const telegramNotification of arrTelegramNotifications) {
    if (currentBatch.length < config.TG_BOT.NOTIFICATION_BATCH_LIMIT) {
      currentBatch.push({
        batchNumber: arrBatches.length + 1,
        notificationNumber: currentBatch.length + 1,
        txt: telegramNotification,
      });
    } else {
      arrBatches.push(currentBatch);
      currentBatch = [];
    }
  }
  if (currentBatch.length > 0) {
    arrBatches.push(currentBatch);
  }

  // set interval to call each batch
  for (let index = 0; index < arrBatches.length; index++) {
    const batch = arrBatches[index];
    setTimeout(() => {
      processTelegramNotificationBatch(batch);
    }, config.TG_BOT.NOTIFICATION_BATCH_INTERVAL_MS * index);
    out.info(
      `Processing notification batch of size: ${batch.length} in ${
        config.TG_BOT.NOTIFICATION_BATCH_INTERVAL_MS * index
      }ms`
    );
  }
}

function processTelegramNotificationBatch(arrTelegramNotificationBatch) {
  out.command(
    `Process notification batch of size ${arrTelegramNotificationBatch.length}`
  );

  for (let index = 0; index < arrTelegramNotificationBatch.length; index++) {
    const notification = arrTelegramNotificationBatch[index];
    setTimeout(() => {
      doTelegramNotification(notification);
    }, config.TG_BOT.NOTIFICATION_INTERVAL_MS * index);
  }
}

/**
 * creates and returns an API fetch response.
 * @param {String} path path to REST method after the baseURL
 * @returns {Promise} unresolved fetch promise
 */
async function callAPI(path, retries = 0) {
  let res = {};
  try {
    if (retries > config.API.RETRY_ATTEMPTS) {
      out.error("Too many retry attempts");
      return res;
    }
    console.info(`Fetching: ${config.API.URL + path}`);

    res = await fetch(config.API.URL + path).catch(async () => {
      out.error(
        `Error fetching from API in callAPI()${
          retries > 0 ? " (retry #" + retries + ")" : ""
        }:`
      );
      return await fetch(config.API.FAILOVER_URL + path).catch(async () => {
        out.error(
          `Error fetching from FAILOVER API in callAPI()${
            retries > 0 ? " (retry #" + retries + ")" : ""
          }:`
        );
        return new Promise(resolve => {
          setTimeout(() => {
            
            if (retries <= config.TG_BOT.NOTIFICATION_RETRIES) {
              resolve(callAPI(path, retries + 1));
            } else {
              //TODO: instead of logging the failed notifications, we should rather have a notification service running seperately from the notable-events which have a "notified" flag which is updated on success only.
            }
          }, config.API.RETRY_INTERVAL_MS);
        });
      });
    });
  } catch (err) {
    out.error(
      `Error fetching from API in callAPI()${
        retries > 0 ? " (retry #" + retries + ")" : ""
      }:`
    );
    out.error(err);

    // out.error(
    //   `Error fetching from API in callAPI()${
    //     retries > 0 ? " (retry #" + retries + ")" : ""
    //   }:`
    // );
    // out.info(config.API.URL + path);
    // out.error(err);
    // try {
    //   res = await fetch(config.API.FAILOVER_URL + path).catch;
    // } catch (err) {
    //   out.error("Error fetching from FAILOVER API in callAPI():");
    //   console.log(config.API.FAILOVER_URL + path);
    //   out.error(err);
    // }
  }
  return res;
}

async function getCoinsInfo(coins) {
  const arrCoinsInfo = [];
  for (const coin of coins) {
    let coinInfo = coin;
    // NATIVE
    if (coin.denom == "uosmo") {
      coinInfo.symbol = "OSMO";
      coinInfo.exponent = 6;
      arrCoinsInfo.push(coinInfo);
      continue;
    }
    if (coin.denom == "uion") {
      coinInfo.symbol = "ION";
      coinInfo.exponent = 6;
      arrCoinsInfo.push(coinInfo);
      continue;
    }

    // IBC ASSET
    if (coin.denom.includes("ibc/")) {
      let lookup = await assetLookupFromAssetlist(coin.denom);
      if (!lookup?.symbol) {
        lookup = await ibcBaseDenomLookup(coin.denom);
      }
      coinInfo = { ...coinInfo, ...lookup };
      arrCoinsInfo.push(coinInfo);
      continue;
    }

    // GAMM
    if (coin.denom.includes("gamm/pool")) {
      coinInfo.symbol = coin.denom;
      arrCoinsInfo.push(coinInfo);
      continue;
    }

    // TOKENFACTORY
    if (coin.denom.includes("factory")) {
      coinInfo.symbol = coin.denom;
      arrCoinsInfo.push(coinInfo);
      continue;
    }
  }
  return arrCoinsInfo;
}

async function getPoolInfo(poolId) {
  // TODO: make call to https://rest.cosmos.directory/osmosis/osmosis/gamm/v1beta1/pools and cache it, and cross reference.

  try {
    const indexedPools = await getIndexedPools();

    // const json = await callAPI("/osmosis/gamm/v1beta1/pools/" + poolId).then(
    //   (res) => res.json()
    // );

    // get denoms from pool:
    let arrDenoms = [];
    try {
      const pool = indexedPools[poolId];
      if (/* normal pool */ pool?.pool_assets) {
        for (const asset of pool.pool_assets) {
          arrDenoms.push(asset.token.denom);
        }
      } else if (/* stable pool */ pool?.pool_liquidity) {
        for (const asset of pool.pool_liquidity) {
          arrDenoms.push(asset.denom);
        }
      }
    } catch (err) {
      out.error("getPoolInfo() - Error getting denoms from pool");
      out.error(err);
    }

    // get pretty names if possible
    const poolAssetSymbols = [];
    try {
      for (const denom of arrDenoms) {
        // pool can contain ibc tokens, tokenfactory tokens, gamms, native...

        // NATIVE
        if (denom == "uosmo") {
          poolAssetSymbols.push("OSMO");
          continue;
        }
        if (denom == "uion") {
          poolAssetSymbols.push("ION");
          continue;
        }

        // IBC ASSET
        if (denom.includes("ibc/")) {
          let lookup = await assetLookupFromAssetlist(denom);
          if (!lookup?.symbol) {
            lookup = await ibcBaseDenomLookup(denom);
          }

          poolAssetSymbols.push(lookup.symbol);
          continue;
        }

        // GAMM
        if (denom.includes("gamm/pool")) {
          poolAssetSymbols.push(denom);
          continue;
        }

        // TOKENFACTORY
        if (denom.includes("factory")) {
          poolAssetSymbols.push(denom);
          continue;
        }
      }
    } catch (err) {
      out.error("getPoolInfo() - Error getting token name from denom");
      out.error(err);
    }

    // return the data
    return {
      poolAssetSymbols: poolAssetSymbols.join(" / "),
    };
  } catch (err) {
    out.error("Error in getPoolInfo():");
    out.error(err);
  }
}

async function getIndexedPools() {
  let indexedPools;
  try {
    // Do some checks first
    if (isIndexedPoolsExpired()) {
      indexedPools = saveIndexedPoolsFromPools();
    } else {
      try {
        indexedPools = getIndexedPoolsFromCache();
        // check if its empty
        if (Object.keys(indexedPools).length === 0) {
          indexedPools = saveIndexedPoolsFromPools();
        }
      } catch (err) {
        out.error(`Error in getIndexedPools()`);
        out.error(err);
        process.exit(0);
      }
    }
    return indexedPools;
  } catch (err) {
    out.error("Error in getIndexedPools()");
    out.error(err);
    process.exit(0);
  }
}

function isIndexedPoolsExpired() {
  const stats = fs.statSync("./cache/indexed-pools.json");
  return (
    (Date.now() - stats.mtime.getTime()) / 1000 > config.POOLS_CACHE_SECONDS
  );
}

function getIndexedPoolsFromCache() {
  try {
    let fileContent = fs.readFileSync("./cache/indexed-pools.json");
    const indexedPools = JSON.parse(fileContent);
    return indexedPools;
  } catch (err) {
    out.error("Error in getIndexedPoolsFromCache");
    out.error(err);
  }
}

/**
 * @returns {indexedPools} indexedPools;
 */
async function saveIndexedPoolsFromPools() {
  const pools = await fetchPoolsFromAPI();
  const indexedPools = indexPools(pools);
  saveIndexedPools(indexedPools);
  return indexedPools;
}

async function fetchPoolsFromAPI() {
  if (config.DEBUG) {
    out.debug("called function:fetchPoolsFromAPI()");
  }
  try {
    out.info("Fetching pools from API (this may take a moment)...");
    const data = await callAPI(
      "/osmosis/gamm/v1beta1/pools?pagination.limit=9999"
    ).then((res) => res.json());
    out.success("Pools data fetched from API!");
    return data?.pools ? data.pools : {};
  } catch (err) {
    out.error("Unable to fetch pools from API:");
    out.error(err.message);
  }
}

function indexPools(pools) {
  let indexedPools = {};
  try {
    for (const pool of pools) {
      try {
        indexedPools[pool.id] = {
          pool_assets: pool?.pool_assets,
          pool_liquidity: pool?.pool_liquidity,
        };
      } catch (err) {
        out.error("Error in indexPools()");
        out.error(err);
      }
    }
    return indexedPools;
  } catch (err) {
    out.error(`Unable to index pools`);
    out.error(err);
    process.exit(0);
  }
}

function saveIndexedPools(indexedPools) {
  const filename = "./cache/indexed-pools.json";
  try {
    fs.writeFileSync(filename, JSON.stringify(indexedPools));
    out.success(`... updated ${filename}`);
  } catch (err) {
    out.error(`Unable to save ${filename}:`);
    out.error(err.message);
    return;
  }
}

async function ibcBaseDenomLookup(denom) {
  try {
    const denom_hex = denom.slice(4);
    const json = await callAPI(
      "/ibc/apps/transfer/v1/denom_traces/" + denom_hex
    ).then((res) => res.json());

    return { symbol: json?.denom_trace?.base_denom };
  } catch (err) {
    out.error(`ibcBaseDenomLookup("${denom}")`);
    out.error(err);
  }
}

async function assetLookupFromAssetlist(denom) {
  try {
    const indexedAssetlist = await getIndexedAssetList();
    const asset = indexedAssetlist[denom];

    if (asset) {
      // out.success("found " + asset?.symbol);
      return {
        symbol: asset?.symbol ? asset.symbol : asset.base,
        exponent: asset?.denom_units[1]?.exponent,
      };
    }
  } catch (err) {
    out.error(`assetLookupFromAssetlist("${denom}")`);
    out.error(err);
  }
}

async function getIndexedAssetList() {
  let indexedAssetlist;
  try {
    if (isAssetlistExpired()) {
      indexedAssetlist = await saveIndexedAssetListFromAssetlist();
    } else {
      try {
        indexedAssetlist = getIndexedAssetListFromCache();
        // check if its empty
        if (Object.keys(indexedAssetlist).length === 0) {
          indexedAssetlist = await saveIndexedAssetListFromAssetlist();
        }
      } catch (err) {
        out.error(`Error in getIndexedAssetList()`);
        out.error(err);
        process.exit(0);
      }
    }
    return indexedAssetlist;
  } catch (err) {
    out.error("Error in getIndexedAssetList()");
    out.error(err);
    process.exit(0);
  }
}

function getIndexedAssetListFromCache() {
  try {
    let fileContent = fs.readFileSync("./cache/indexed-assetlist.json");
    const indexedAssetlist = JSON.parse(fileContent);
    return indexedAssetlist;
  } catch (err) {
    out.error("Error in getIndexedAssetListFromCache");
    out.error(err);
  }
}

function isAssetlistExpired() {
  const stats = fs.statSync("./cache/indexed-assetlist.json");
  return (
    (Date.now() - stats.mtime.getTime()) / 1000 > config.ASSETLIST_CACHE_SECONDS
  );
}

async function saveIndexedAssetListFromAssetlist() {
  const assetlist = await getAssetList();
  const indexedAssetlist = indexAssetlist(assetlist);
  saveIndexedAssetList(indexedAssetlist);
  return indexedAssetlist;
}

function saveIndexedAssetList(indexedAssetlist) {
  const filename = "./cache/indexed-assetlist.json";
  try {
    fs.writeFileSync(filename, JSON.stringify(indexedAssetlist));
    out.success(`... updated ${filename}`);
  } catch (err) {
    out.error(`Unable to save ${filename}:`);
    out.error(err.message);
    return;
  }
}

// create the indexedAssetlist from assetlist.
// this makes later referencing on a lot quicker.

/**
 * create the indexedAssetlist from assetlist. this makes later lookups a lot quicker.
 * @param {assetlist}
 * @returns {indexedAssetList} indexedAssetList
 */
function indexAssetlist(assetlist) {
  let indexedAssetlist = {};
  try {
    for (const asset of assetlist.assets) {
      try {
        indexedAssetlist[asset.base] = {
          symbol: asset?.symbol,
          denom_units: asset?.denom_units[1],
        };
      } catch (err) {
        out.error("Error in indexAssetlist()");
        out.error(err);
      }
    }
    return indexedAssetlist;
  } catch (err) {
    out.error(`Unable to index assetlist`);
    out.error(err);
    process.exit(0);
  }
}

/**
 * return assetlist from cache, or fetch from API if older than config.API.ASSETLIST_CACHE_SECONDS
 * @returns {assetList} assetlist
 */
async function getAssetList() {
  let assetlist;
  const filename = "./cache/assetlist.json";

  // check if assetlist has expired
  try {
    const stats = fs.statSync(filename);
    if (
      (Date.now() - stats.mtime.getTime()) / 1000 >
      config.ASSETLIST_CACHE_SECONDS
    ) {
      out.info("fetchFromAPI()");
      return await fetchAssetlistFromAPI();
    }
  } catch (err) {
    out.error(`Unable to read ${filename}`);
    out.error(err);
    process.exit(0);
  }

  // check if assetlist is empty
  try {
    let fileContent = fs.readFileSync(filename);
    assetlist = JSON.parse(fileContent);
    if (Object.keys(assetlist).length === 0) {
      return await fetchAssetlistFromAPI();
    }
  } catch (err) {
    out.error(`Error parsing ${filename}`);
    out.error(err);
    process.exit(0);
  }

  return assetlist;

  async function fetchAssetlistFromAPI() {
    let assetlist;
    if (config.DEBUG) {
      out.debug("Updating assetlist.json from API and saving to cache...");
    }
    try {
      assetlist = await fetch(
        "https://raw.githubusercontent.com/osmosis-labs/assetlists/main/osmosis-1/osmosis-1.assetlist.json",
        {
          cache: "reload",
        }
      ).then((res) => res.json());
    } catch (err) {
      out.error("Unable to fetch assetlist from github:");
      out.error(err.message);
    }

    if (assetlist) {
      // save to cache
      try {
        fs.writeFileSync(filename, JSON.stringify(assetlist));
        out.success(`... updated ${filename}`);
      } catch (err) {
        out.error("Unable to save assetlist.json:");
        out.error(err.message);
        return;
      }
    }
    return assetlist;
  }
}

async function initializeFiles() {
  const filenames = [
    "./cache/assetlist.json" /* raw assetlist as per osmosis github */,
    "./cache/deltas.json" /* gauge changes */,
    "./cache/gauges.json" /* raw gauges as per osmosis api*/,
    "./cache/indexed-assetlist.json" /* assetlist, but keys are denom bases, and most of the data is stripped.*/,
    "./cache/indexed-gauges.json" /* gauges, but keys are gauge id */,
    "./cache/indexed-gauges-old.json" /* record of outdated (previous) indexed gauges */,
    "./cache/indexed-pools.json" /* pools, but keys are pool-ids */,
    "./cache/notable-events.json" /* latest events which should be notified*/,
  ];

  for (const filename of filenames) {
    try {
      if (!fs.existsSync(filename)) {
        fs.writeFileSync(filename, "{}");
        out.success(`File '${filename}' created successfully!`);
      }
    } catch (err) {
      out.error(`initializeFiles: ${filename}`);
      out.error(err);
      process.exit(0);
    }
  }
}

// this tells the telegram bot to send a message...
function doTelegramNotification(notification, retries = 0) {
  if (config.DEBUG) {
    out.debug("called function: doTelegramNotification()");
  }

  config.TG_BOT.GROUP_IDS.forEach((groupId) => {
    const json_body = {
      chat_id: groupId,
      text: notification.txt,
    };

    fetch(
      `https://api.telegram.org/bot${config.TG_BOT.TOKEN}/sendMessage?parse_mode=html&disable_web_page_preview=true `,
      {
        method: "POST",
        body: JSON.stringify(json_body),
        headers: {
          "Content-Type": "application/json",
        },
      }
    )
      .then((res) => res.json())
      .then((json) => {
        if (!json?.ok) {
          out.error(
            `Unable to send Telegram notification${
              retries > 0 ? " (retry #" + retries + ")" : ""
            }:`
          );
          console.log(json);
          if (json?.parameters?.retry_after) {
            console.info(`retrying after ${json.parameters.retry_after}s`);
          }
          setTimeout(
            () => {
              if (retries <= config.TG_BOT.NOTIFICATION_RETRIES) {
                doTelegramNotification(notification, retries++);
              } else {
                //TODO: instead of logging the failed notifications, we should rather have a notification service running seperately from the notable-events which have a "notified" flag which is updated on success only.
              }
            },
            json?.parameters?.retry_after
              ? json.parameters.retry_after * 1000
              : 10000
          );
        } else {
          out.success(
            `Telegram notification successful - [batch #${notification.batchNumber}; msg #${notification.notificationNumber}]`
          );
        }
      })
      .catch((err) => {
        out.error(err);
        if (retries <= config.TG_BOT.NOTIFICATION_RETRIES) {
          setTimeout(
            () => {
              doTelegramNotification(notification, retries++);
            },
            json?.parameters?.retry_after
              ? json.parameters.retry_after * 1000
              : 10000
          );
        } else {
          //TODO: instead of logging the failed notifications, we should rather have a notification service running seperately from the notable-events which have a "notified" flag which is updated on success only.
        }
      });
  });
}

function timeUntilEpoch_fromStartTime(strStartTime) {
  const currentDate = new Date();
  let startDate = new Date(strStartTime);

  // if it is in the past... set to today
  if (startDate.getTime() < currentDate.getTime()) {
    startDate = currentDate;
  }

  const startingEpoch = new Date(startDate); // Make a copy of the current date

  // Set the hours to 19 (7pm) and the minutes, seconds and milliseconds to 0
  startingEpoch.setHours(config.EPOCH_HOUR, 16, 0, 0);

  // If the next 7pm is not on the same day as the current date, add a day
  if (startingEpoch <= startDate) {
    startingEpoch.setDate(startingEpoch.getDate() + 1);
  }

  const duration = startingEpoch.getTime() - currentDate.getTime(); // Get the duration in milliseconds
  const days = Math.floor(duration / (1000 * 60 * 60 * 24)); // Calculate the number of days
  const hours = Math.floor((duration / (1000 * 60 * 60)) % 24); // Calculate the number of hours
  const minutes = Math.floor((duration / (1000 * 60)) % 60); // Calculate the number of minutes

  return `${days}d, ${hours}h, ${minutes}m`;
}

(() => {
  function cleanUp(eventType) {
    out.warn(eventType);
    if (eventType == "exit") {
      const endTime = Date.now();
      out.info(`Total processing time: ${endTime - startTime} ms`);
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
