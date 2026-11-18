# Reviewer questions and evidence

These are preparation notes, not answers attributed to a supervisor or examiner.

**What has actually been evaluated?** A shared local delivery core using memory adapters, phased fan-out and a loopback HTTP mock. The recorded suite contains 90 measured trials and 33,300 mock acceptances. It does not measure deployed Azure or browser delivery.

**Why is provider acceptance a separate metric?** A provider response covers that request. The prototype separately records a browser-reported notification creation and a click event. Neither establishes that a human read the content.

**Is the service independent of browser push providers?** Campaign management and storage are self-managed, but real Web Push still uses the endpoint selected by the browser. The mock substitutes that transport only for synthetic testing.

**Why are there two queues?** The campaign queue carries campaign work; fan-out creates deterministic delivery jobs on the delivery queue. This separates recipient expansion from provider attempts and supports persisted recovery.

**Does duplicate handling guarantee exactly-once delivery?** No. Persisted identities and state checks reduce repeat work, but a crash after provider acceptance can leave an ambiguous outcome. A retry can duplicate a notification.

**When is audience membership evaluated?** Preview supports review. Activation checks the reviewed version/fingerprint and freezes the recipient list for that campaign. Tag membership changes afterward do not silently expand it.

**What is the pause guarantee?** Dispatch/sending controls are persisted and checked before new work proceeds. They cannot recall an accepted request or create a monetary hard cap.

**What does fresh versus reused mean?** Fresh repetitions start a new driver/mock and child host. Reused scenarios exclude one warm-up and retain both processes for measured trials with fresh datasets. The experiment does not isolate host reuse alone.

**What was the effect of more workers?** At 1,000 recipients with reused processes, observed medians were 238.12/s, 556.00/s and 889.69/s at one, two and four workers. These are descriptive local mock results, without a significance or production capacity claim.

**Is warm-up always beneficial?** The recorded medians do not support that claim. At 100 recipients and one worker, reused median elapsed was 397.15 ms versus 372.19 ms fresh. Process conditions and time drift limit causal interpretation.

**Why have the Azure and 100,000-recipient objectives not been completed?** Cloud deployment remains off under the strict spending decision, and the current research/data model is bounded at 1,000 synthetic recipients. The original objectives remain open until supported by evidence or an academically accepted scope amendment.

**Is the project proven to cost less than INR 100?** No monetary result was measured. This suite creates no Azure resources, but it does not establish the user's overall account bill or compare cloud costs.

**How can the results be checked?** Use the measured commit and frozen archives. Replay validates hashes, deterministic recipients, attempts, provider observations, final outcomes and derived statistics. Hashes detect content changes and are not a signature of authenticity.

**Is the draft ready for final submission?** Review materials are prepared. Institutional format, declarations, permitted AI-assistance disclosure, missing validation and supervisor/examiner decisions remain to be completed and recorded.
