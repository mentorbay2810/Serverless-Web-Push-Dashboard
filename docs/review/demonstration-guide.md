# Demonstration guide

Present the persistent local application and synthetic experiments as separate demonstrations. This guide does not record that a new demonstration has happened.

## Prepare

Use the intended source commit and Node 22.19+ or 24. Preserve the original VAPID keys for existing subscribers. Run only one backend against the private data directory.

```sh
npm ci
npm run setup
npm run doctor
npm run build
npm start -- --paused
```

Open the configured local frontend origin. In a separate terminal run `npm run admin:login`, then open its one-use link privately. It expires after two minutes and establishes a one-hour local administrator session. Record browser/OS versions and the source commit in the demonstration record. Pairing URLs and bearer credentials must not appear in screenshots or submitted logs.

Starting paused is for inspecting restored work. Inspect pending campaigns and subscriptions before deliberately resuming dispatch and sending in the administrator operations controls. Pauses persist; do not infer a clean queue from a fresh process.

## Persistent application demonstration

1. On the subscriber page, allow notifications and wait for **Connected**. Record denied/revoked permission cases separately when exercised.
2. Pair the administrator session. Show subscriber summaries and assign a harmless demonstration tag.
3. Create a draft for the intended browser or tag. Preview it and verify the recipient count. Activation freezes the reviewed audience.
4. Resume the required operational controls deliberately, then send one notification. Record campaign ID and provider outcome using the dashboard's redacted view.
5. Observe the actual device. Record whether an OS notification appeared. A receipt indicates the service-worker notification creation path; it does not prove that a person saw the banner.
6. If a real notification is clicked, record the safe destination and the click count independently. Do not use a synthetic event request as click evidence.
7. Demonstrate a short future schedule and cancellation only after checking that no unintended recipients are selected. Record outcomes rather than assuming cancellation can recall accepted work.
8. If restart recovery is demonstrated, stop with Ctrl+C, wait for exit and restart the same queued profile. Do not delete private state or rotate keys to make a result appear clean.

For unavailable devices, permission modes, offline/tab-closed behavior or viewport/keyboard checks, record **not exercised**. Earlier project receipts are historical evidence and do not replace the new device record.

## Automated evidence demonstration

Stop application services before a validation or timing run. These checks use controlled senders and disposable or synthetic state:

```sh
npm run validate:local
npm run research:smoke
npm run review:check
```

For the saved study, run `npm run review:verify` when the original local artifacts are available, or `npm run research:analyze -- <extracted-study-directory> --verify`. Explain the 18-scenario protocol, the 90 measured trials, the excluded warm-ups and the mock-provider scope. Show raw observations alongside the derived table and charts.

Do not rerun the full timing study while services, tests or other heavy workloads are active. A fresh process is not an Azure cold start. The local cost fields are unmeasured. Keep deployment off under the recorded strict INR 100 decision.

## Record and finish

Use `browser-observations.csv` for actual device observations and attach redacted evidence only when it exists. Record acceptance, receipt, OS display and click as separate fields. Close the administrator session, stop the local services and verify shutdown before copying state. Keep private `.env`, `.data`, subscription endpoints and signing material outside the review bundle.
