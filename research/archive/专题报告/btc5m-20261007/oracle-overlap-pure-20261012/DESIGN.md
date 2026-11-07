# Rolling oracle window hypothesis

Chainlink's official timestamp guide describes a TWAP as a moving window anchored to the latest observation, with report prices weighted by their actual report duration. Window overlap does not imply independent one-second price increments.

In a zero-drift Brownian instantaneous-price approximation, let W(t) be the trailing T-second uniform average. Var(W(t+h)-W(t))/sigma_spot^2 is h^2/T-h^3/(3T^2) for h<=T and h-T/3 for h>=T. Conditional on the full price history through t, future uncertainty is h^3/(3T^2) for h<=T and h-2T/3 otherwise. These are different questions. In particular, a late horizon may contain mostly already observed reports, but its conditional mean requires the actual underlying history; it cannot be supplied by the current TWAP alone.

The current accepted source estimates a mean of squared TWAP log increments divided by each actual time interval. The implied Brownian spot-variance proxy divides that statistic by the mean of the unconditional kernel variance divided by the respective interval. With one-second sampling and T=60 this factor is roughly 1/60. It is not a claim that true BTC volatility is exactly the proxy, or that every forecast is overconfident: drift, jumps, overlapping-sample uncertainty, venue basis, report gaps and oracle delivery complicate the model. No winner, fitting, calibrated probability, fund replay or order is permitted by this pure prototype.

Next source-only descriptive check: reconstruct all already audited first-pilot history witnesses and intervals, reproduce original supplied sigma, and summarize the hypothetical variance ratios by source horizon. Any teacher or net-signal candidate must then use all original authenticated history and strict temporal, numerical and money comparisons before a future order trial.

Primary source: https://docs.chain.link/data-streams/how-report-timestamps-work
