"""Build the private academic review DOCX using the bundled document runtime."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from datetime import datetime
from zoneinfo import ZoneInfo
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT

ROOT = Path(__file__).resolve().parents[2]


def academic_details(path):
    source = Document(path)
    paragraphs = [p.text.strip() for p in source.paragraphs if p.text.strip()]
    text = "\n".join(paragraphs)
    def match(pattern):
        value = re.search(pattern, text)
        if not value:
            raise ValueError("The outline is missing an academic detail required for the review cover.")
        return value.group(1).strip()
    data = {"student": match(r"Student Name:\s*([^\n]+)"), "student_id": match(r"BITS ID:\s*([^\n]+)"),
            "course": match(r"Course No\.\s*:\s*([^\n]+)"), "degree": match(r"Degree Program:\s*([^\n]+)").replace("Infrastracture", "Infrastructure")}
    for table in source.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            if len(cells) == 3 and cells[0] == "Name":
                data["supervisor"], data["examiner"] = cells[1:]
    if not data.get("supervisor") or not data.get("examiner"):
        raise ValueError("Supervisor and examiner names were not found in the outline.")
    # Contact details, signatures and supervisor remarks are deliberately not copied.
    return data


def element(tag, **attributes):
    node = OxmlElement(tag)
    for key, value in attributes.items(): node.set(qn(key), str(value))
    return node


def link(paragraph, label, target):
    hyperlink = element("w:hyperlink")
    hyperlink.set(qn("r:id"), paragraph.part.relate_to(target, RT.HYPERLINK, is_external=True))
    run = element("w:r")
    properties = element("w:rPr")
    properties.append(element("w:color", **{"w:val": "1F4E79"}))
    properties.append(element("w:u", **{"w:val": "single"}))
    run.append(properties)
    text = element("w:t"); text.text = f"[{label}]" if label.isdigit() else label; run.append(text)
    hyperlink.append(run); paragraph._p.append(hyperlink)


def inline(paragraph, value):
    pattern = r"(\[[^\]]+\]\(https?://[^)]+\)|`[^`]+`|\*\*[^*]+\*\*)"
    for part in re.split(pattern, value):
        match = re.fullmatch(r"\[([^\]]+)\]\((https?://[^)]+)\)", part)
        if match: link(paragraph, *match.groups())
        elif part.startswith('`') and part.endswith('`'):
            run = paragraph.add_run(part[1:-1]); run.font.name = "Courier New"; run.font.size = Pt(9.5)
        elif part.startswith('**') and part.endswith('**'): paragraph.add_run(part[2:-2]).bold = True
        else: paragraph.add_run(part)


def styles(doc):
    section = doc.sections[0]
    section.page_width = Inches(8.5); section.page_height = Inches(11)
    section.top_margin = Inches(.78); section.bottom_margin = Inches(.75)
    section.left_margin = section.right_margin = Inches(.85)
    section.header_distance = section.footer_distance = Inches(.33)
    for name in ["Normal", "Title", "Subtitle", "Heading 1", "Heading 2", "Caption"]:
        style = doc.styles[name]; style.font.name = "Arial"; style.font.color.rgb = RGBColor(0, 0, 0)
        style.element.get_or_add_rPr().append(element("w:rFonts", **{"w:ascii": "Arial", "w:hAnsi": "Arial"}))
    normal = doc.styles['Normal']; normal.font.size = Pt(11.5)
    normal.paragraph_format.line_spacing = 1.12; normal.paragraph_format.space_after = Pt(8)
    normal.paragraph_format.widow_control = True
    doc.styles['Title'].font.size = Pt(25); doc.styles['Title'].font.bold = True
    doc.styles['Title'].paragraph_format.space_after = Pt(16)
    doc.styles['Subtitle'].font.size = Pt(13)
    doc.styles['Subtitle'].font.italic = False
    for name, size in [('Heading 1', 15), ('Heading 2', 12)]:
        style = doc.styles[name]; style.font.size = Pt(size); style.font.bold = True
        style.paragraph_format.keep_with_next = True; style.paragraph_format.space_before = Pt(14); style.paragraph_format.space_after = Pt(8)
    doc.styles['Caption'].font.size = Pt(9.5); doc.styles['Caption'].font.italic = False
    doc.styles['Caption'].paragraph_format.space_after = Pt(8)
    section.different_first_page_header_footer = True
    header = section.header.paragraphs[0]
    header.text = 'Serverless Web Push Dashboard | Academic review draft'
    header.runs[0].font.size = Pt(9); header.runs[0].font.color.rgb = RGBColor(0, 0, 0)
    for footer in [section.footer, section.first_page_footer]:
        p = footer.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        run = p.add_run('Review draft  |  Page '); run.font.size = Pt(9)
        for instruction in ['PAGE', 'NUMPAGES']:
            if instruction == 'NUMPAGES': p.add_run(' of ').font.size = Pt(9)
            run = p.add_run(); run.font.size = Pt(9)
            run._r.append(element('w:fldChar', **{'w:fldCharType': 'begin'}))
            code = element('w:instrText'); code.text = instruction; run._r.append(code)
            run._r.append(element('w:fldChar', **{'w:fldCharType': 'end'}))


def table(doc, lines, number):
    rows = [[part.strip() for part in line.strip('|').split('|')] for line in lines]
    rows = [row for row in rows if not all(re.fullmatch(r'[:\- ]+', cell) for cell in row)]
    captions = ['Objective and evidence alignment', 'Local demonstration limits', 'Recorded experiment settings', 'Measured local outcomes with five repetitions per condition', 'Validity considerations', 'Open review items']
    caption = doc.add_paragraph(f'Table {number} {captions[number - 1]}', 'Caption'); caption.paragraph_format.keep_with_next = True
    t = doc.add_table(rows=1, cols=len(rows[0])); t.alignment = WD_TABLE_ALIGNMENT.CENTER; t.autofit = False
    widths = {2: [2.3, 4.4], 3: [1.9, 2.55, 2.25], 6: [.85, .8, .9, 1.2, 1.4, 1.55]}[len(rows[0])]
    for column, width in zip(t.columns, widths): column.width = Inches(width)
    borders = element('w:tblBorders')
    for edge in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
        borders.append(element(f'w:{edge}', **{'w:val': 'single', 'w:sz': 5, 'w:color': 'D9D9D9'}))
    t._tbl.tblPr.append(borders)
    for i, row in enumerate(rows):
        cells = t.rows[0].cells if i == 0 else t.add_row().cells
        row_node = cells[0]._tc.getparent(); row_node.get_or_add_trPr().append(element('w:cantSplit'))
        if i == 0: row_node.get_or_add_trPr().append(element('w:tblHeader'))
        for j, value in enumerate(row):
            cell = cells[j]; cell.width = Inches(widths[j]); cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            margins = element('w:tcMar')
            pad = 40 if len(row) == 6 else 65
            for side, size in [('top', pad), ('bottom', pad), ('left', 95), ('right', 95)]: margins.append(element(f'w:{side}', **{'w:w': size, 'w:type': 'dxa'}))
            cell._tc.get_or_add_tcPr().append(margins)
            cell._tc.get_or_add_tcPr().append(element('w:shd', **{'w:fill': '1F3B52' if i == 0 else ('F3F6F8' if i % 2 == 0 else 'FFFFFF')}))
            p = cell.paragraphs[0]; p.paragraph_format.space_after = Pt(1 if len(row) == 6 else 2); p.paragraph_format.space_before = Pt(1 if len(row) == 6 else 2); p.paragraph_format.line_spacing = 1.05
            if len(row) == 6: p.alignment = WD_ALIGN_PARAGRAPH.CENTER if j in [0, 1, 2] else WD_ALIGN_PARAGRAPH.RIGHT
            inline(p, value)
            for run in p.runs:
                run.font.size = Pt(10.2); run.font.bold = i == 0
                run.font.color.rgb = RGBColor.from_string('FFFFFF' if i == 0 else '000000')
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--outline', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / '.cache/review/phase-8/deliverables')
    args = parser.parse_args(); output = args.output.resolve()
    if not output.is_relative_to((ROOT / '.cache/review').resolve()): raise ValueError('Keep private academic documents under the ignored .cache/review directory.')
    summary = json.loads((ROOT / 'docs/review/evidence-summary.json').read_text())
    verified = json.loads((ROOT / '.cache/review-inputs/verified.json').read_text())
    if verified['status'] != 'verified_local_review_inputs' or verified['analysisSha256'] != summary['analysisSha256']: raise ValueError('Run npm run review:verify before creating the document.')
    for artifact in summary['artifacts']:
        if hashlib.sha256((ROOT / artifact['path']).read_bytes()).hexdigest() != artifact['sha256']: raise ValueError('A frozen input archive changed.')
    details = academic_details(args.outline)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    source_clean = not subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip()
    source = (ROOT / 'docs/review/report.md').read_text()
    doc = Document(); styles(doc)
    doc.core_properties.title = 'Serverless Web Push Notification Service Dashboard'
    doc.core_properties.subject = 'Local prototype and measured evidence for academic review'
    doc.core_properties.author = details['student']; doc.core_properties.keywords = f'review draft; measured source {summary["measurement"]["sourceCommit"]}'
    cover = doc.add_paragraph('Serverless Web Push Notification Service Dashboard', 'Title')
    cover.paragraph_format.space_before = Pt(45)
    doc.add_paragraph('Dissertation review draft', 'Subtitle')
    for line in [details['student'], f'BITS ID {details["student_id"]}', details['degree'], f'Course {details["course"]}', 'Birla Institute of Technology and Science Pilani', 'Work Integrated Learning Programmes', 'Project location Wipro Gopanapally Campus']:
        p = doc.add_paragraph(line); p.paragraph_format.space_after = Pt(5)
    doc.add_paragraph(f'Supervisor {details["supervisor"]}')
    doc.add_paragraph(f'Additional examiner {details["examiner"]}')
    p = doc.add_paragraph('Prepared for academic review'); p.runs[0].bold = True; p.paragraph_format.space_before = Pt(18)
    doc.add_paragraph('This draft presents a working local prototype and verified local experiments. Azure comparison, monetary costs, large audiences and full device validation remain open. No academic approval or final submission is recorded.')
    doc.add_paragraph('Academic details are reproduced from the supplied outline. Signatures, contact details and supervisor remarks are not reproduced.')
    p = doc.add_paragraph(f'Review build {commit[:12]}  |  '+datetime.now(ZoneInfo('Asia/Kolkata')).strftime('%d %B %Y'))
    p.runs[0].font.size = Pt(9.5)
    lines = source.splitlines(); index = 0; started = False; figure_number = 0; table_number = 0
    while index < len(lines):
        line = lines[index].strip(); index += 1
        if line.startswith('## '):
            title = line[3:]; number = int(title.split()[0])
            h = doc.add_paragraph(title, 'Heading 1')
            h.paragraph_format.page_break_before = True
            started = True
        elif not started or not line or line.startswith('<!--'): continue
        elif line.startswith('|'):
            block = [line]
            while index < len(lines) and lines[index].strip().startswith('|'): block.append(lines[index].strip()); index += 1
            table_number += 1; table(doc, block, table_number)
        elif line.startswith('!['):
            match = re.fullmatch(r'!\[([^\]]+)\]\(([^)]+)\)', line)
            if not match: raise ValueError('Invalid figure markup.')
            figure_number += 1; alt, name = match.groups(); image = (ROOT / 'docs/review' / name).resolve()
            if not image.is_relative_to((ROOT / 'docs/review/assets').resolve()): raise ValueError('Figure path escapes the public assets directory.')
            p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; p.paragraph_format.keep_with_next = True; p.paragraph_format.space_after = Pt(4)
            shape = p.add_run().add_picture(str(image), width=Inches(6.7)); shape._inline.docPr.set('descr', alt)
            doc.add_paragraph(f'Figure {figure_number} {alt}', 'Caption')
        else:
            paragraph = line
            while index < len(lines) and lines[index].strip() and not lines[index].startswith(('#', '|', '![', '<!--')):
                paragraph += ' ' + lines[index].strip(); index += 1
            p = doc.add_paragraph(); inline(p, paragraph)
    output.mkdir(parents=True, exist_ok=True)
    # Blank Word templates can carry paragraph borders in their Title style.
    # Remove those rules while retaining actual table cell borders.
    for tree in [doc.styles.element, doc.element, *[part._element for part in [doc.sections[0].header, doc.sections[0].footer, doc.sections[0].first_page_footer]]]:
        for border in tree.xpath('.//w:pBdr'): border.getparent().remove(border)
    target = output / 'Dissertation_Review_Draft.docx'; doc.save(target)
    metadata = {'schemaVersion': 1, 'status': 'draft_for_academic_review', 'reviewSourceCommit': commit, 'reviewSourceWasClean': source_clean,
                'measuredSourceCommit': summary['measurement']['sourceCommit'], 'studyId': summary['measurement']['experimentId'],
                'outlineSha256': hashlib.sha256(args.outline.read_bytes()).hexdigest(), 'reportMarkdownSha256': hashlib.sha256(source.encode()).hexdigest(),
                'docxSha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'academicApprovalRecorded': False, 'finalSubmissionRecorded': False}
    (output / 'document-provenance.json').write_text(json.dumps(metadata, indent=2)+'\n')
    print(f'Saved editable review draft to {target}')


if __name__ == '__main__': main()
