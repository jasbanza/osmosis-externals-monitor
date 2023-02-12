export default {
  EPOCH_HOUR: 19 /* Which hour osmosis epoch is relative to this server's timezone */,
  API_QUERY: {
    URL: "https://your.node/osmosis/incentives/v1beta1/gauges?pagination.limit=9999",
    RATE_LIMIT_SECONDS: 60 /* Only necessary if you have reattempt this script multiple times  */,
  },
  TG_BOT: {
    ACTIVE: true,
    TOKEN: "1231231231:AAEs123QaayKssZ123rDfR6MXTpGRZksiyA",
    GROUP_IDS: ["-100123123123"],
  },
  DELTAS: {
    SEND_TO_DB: {
      ENABLED: true,
      CLUSTER: "",
      DATABASE: "",
      COLLECTION: "",
      USERNAME: "",
      PASSWORD: "",
    } /* output to MONGO DB CLUSTER */,
    SEND_TO_FILE: true /* output (overwrite) deltas to ./cache/deltas.json */,
    SEND_TO_STDOUT: false /* output deltas to console */,
  },
  DEBUG: false /* output verbose debug info to console*/,
  BEHAVIOR: {
    IGNORE_EMPTY_DATA: 0 /* continue if API query fails or returns no data*/,
    SKIP_API_FETCH_GET_CACHED: 0 /* Read gauges from gauges.json not from API */,
    SKIP_SAVE_OLD_GAUGES: 0 /* Don't overwrite the old file */,
    SKIP_SAVE_GAUGES: 0 /* Don't overwrite the new file */,
    SKIP_SAVE_INDEXED_GAUGES: 0 /* Don't overwrite the new indexed file */,
    SKIP_SAVE_OLD_INDEXED_GAUGES: 0 /* Don't overwrite the old indexed file */,
  },
  NOTIFICATIONS: {
    DURATION_14: {
      NEAR_EXPIRATION: true,
      EXPIRED: true,
    },
    DURATION_7: {
      NEAR_EXPIRATION: true,
      EXPIRED: true,
    },
    DURATION_1: {
      NEAR_EXPIRATION: true,
      EXPIRED: true,
    },
  },
};
