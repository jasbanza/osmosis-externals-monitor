# osmosis-externals-monitor

On demand Node.js script to:
- Poll and cache Osmosis Zone's external incentive gauges from the API (osmosis/pool-incentives/v1beta1/external_incentive_gauges)
- Locally compare historic gauges with newly polled ones.
- Extracts useful insights from external gauges deltas, such as:
  - new incentives
  - incentives starting soon
  - soon-to-be-expiring (e.g. 14 days of incentives remaining on a 14 day gauge)
  - ...

The possibilities are endless once you have the deltas on hand. One could even make a telegram bot which handles deltas for user profiles!
e.g. a user watches:
  - certain pools
  - certain reward denoms
  - certain wallet(s) for bonded pools nearing expiration
