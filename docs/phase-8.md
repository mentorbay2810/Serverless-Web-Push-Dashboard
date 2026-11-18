# Phase 8: review and submission preparation

Candidate `0.1.0-rc.4` adds an evidence-based review report, public numerical summary, print figures, demonstration instructions, reviewer questions, an open-gap register and blank observation/feedback records. Reusable tooling checks the public report against frozen values and generates a private editable Word draft from the supplied outline.

This phase prepares materials for review. It does not record academic approval, completed feedback, signatures, publication or final submission. The original outline's Azure comparison, 100,000-recipient evaluation and full browser validation remain open. The strict INR 100 decision continues to keep cloud deployment off.

## Review materials

The [review index](review/README.md) links the report and supporting documents. The report distinguishes the persistent local app, prepared Azure topology and memory-adapter benchmark. It uses primary protocol/documentation sources and records when only publication metadata or an abstract was reviewed. Commercial provider pricing is not inferred from the outline's motivation.

Measured results remain tied to `0.1.0-rc.3` at commit `8c46a4c0f5849b29d9e06b4ebc157b9d1762fab1`: 18 scenarios, 90 measured trials and 33,300 mock acceptances, with nine excluded warm-ups and 96 recorded passing tests. The review candidate has its own validation/source identity; adding documentation does not create a new performance measurement.

The Word cover reads academic details from the local outline. Generated Word/provenance files stay in ignored `.cache/review/`; personal details, original contact records, signatures and reviewer remarks are not added to the public report or code. The final document must be rendered with the Documents skill and every page inspected before delivery. QA page images and its intermediate PDF stay outside the deliverables folder.

## Verification and generation

```sh
npm run review:check
npm run review:verify
python3 tools/review/build.py --outline /private/path/to/outline.docx
```

The first command checks public counts, trial-derived statistics, historical test provenance, report table values, references and the disabled-cloud decision. It requires no private files and runs in public CI. The second replays the original local raw study and verifies frozen research/source archive hashes; it needs those ignored artifacts. The builder uses verified inputs, committed figures and a Python runtime with `python-docx`; Codex uses the bundled document runtime. Optional requirements for recreating figures are recorded under `tools/review/`.

The default editable output is `.cache/review/phase-8/deliverables/Dissertation_Review_Draft.docx`. A separate local package combines the draft, source/research evidence, guides, gap register and manifests. No private environment files or subscriber state belongs in that package.

## Decisions before final submission

- Confirm academic metadata, the current format, reference requirements, declarations and permitted AI-assistance disclosure.
- Obtain actual supervisor/examiner feedback and record responses with their evidence.
- Address the missing Azure, scale, cost and browser objectives through new authorized evidence or an academically accepted scope amendment.
- Recheck the complete development toolchain and the final operating/retention limits.
- Regenerate and visually inspect the revised document, obtain genuine required approvals/signatures and confirm the submission channel/date.

The original outline proposes review on 4-19 January 2027 and submission on 20-30 January 2027. Those are supplied planning windows, not verified current institutional deadlines. Use [the submission checklist](review/submission-checklist.md); blank logs and prepared documents must not be treated as completed review or submission.
