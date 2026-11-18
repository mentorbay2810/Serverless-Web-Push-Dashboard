# Academic review materials

The public report and numerical summary describe the implemented local prototype and the frozen Phase 7 study. They omit personal academic details. The editable Word draft is generated locally from the supplied outline and kept under ignored `.cache/review/`, together with its private provenance record. The original outline and its contact/signature sections are not copied into source control.

- [Report](report.md): implementation, protocol context, measured results and scope limitations.
- [Numerical evidence summary](evidence-summary.json): selected values from the verified study; raw evidence remains a separate artifact.
- [Demonstration guide](demonstration-guide.md) and [reviewer questions](reviewer-questions.md).
- [Submission checklist](submission-checklist.md), [gap register](gaps.csv), and blank [browser observations](browser-observations.csv) and [review log](review-log.csv).
- [Reference basis](references.json): primary links and the depth of source review.

`npm run review:check` checks the public summary's counts, trial-derived statistics, historical test provenance and cloud-off policy. CI can run it without private documents or local raw archives. `npm run review:verify` additionally replays the original local raw study and checks both frozen archives; those ignored artifacts must be present.

To build the editable document with a Python runtime that includes `python-docx`, verify inputs first, then:

```sh
npm run review:verify
python3 tools/review/build.py --outline /private/path/to/outline.docx
```

The default output is `.cache/review/phase-8/deliverables/Dissertation_Review_Draft.docx`. Generated academic documents are restricted to ignored `.cache/review/`. The cover uses student/supervisor/examiner names from the outline; it excludes contact details, signatures and supervisor remarks. Formatting is a review design, not an asserted institutional template.

Committed print figures are sufficient for a Word rebuild. Optional figure regeneration uses `tools/review/figures.py` with ReportLab, then `tools/review/rasterize.cjs` with a supplied Node module directory containing Sharp. Codex uses the documented bundled runtimes for these steps. After any document change, run the Documents skill renderer and inspect every page before delivery; keep its QA page images/PDF outside deliverables.

The measured code is `0.1.0-rc.3` at commit `8c46a4c0f5849b29d9e06b4ebc157b9d1762fab1`. Review tooling is prepared as `0.1.0-rc.4`; its validation/source bundle is recorded separately. Documentation work does not rerun or replace the original measurements. The package is prepared for review, with academic acceptance and final submission still pending.
