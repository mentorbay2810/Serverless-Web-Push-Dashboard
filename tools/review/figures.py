"""Create document-sized vector diagrams and statistical charts from the frozen public summary."""
import json
import math
from pathlib import Path
from reportlab.graphics import renderSVG
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon, Circle
from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.lib import colors

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs/review/assets"
DATA = json.loads((ROOT / "docs/review/evidence-summary.json").read_text())
BLUE = colors.HexColor("#167b8a")
ORANGE = colors.HexColor("#c05a30")
GRAY = colors.HexColor("#d9dfe5")


def text(d, x, y, value, size=10, bold=False, color=colors.black, anchor="start"):
    d.add(String(x, y, value, fontName="Helvetica-Bold" if bold else "Helvetica", fontSize=size, fillColor=color, textAnchor=anchor))


def arrow(d, points, color=colors.HexColor("#465563")):
    for a, b in zip(points, points[1:]):
        d.add(Line(*a, *b, strokeColor=color, strokeWidth=1.2))
    a, b = points[-2:]
    angle = math.atan2(b[1] - a[1], b[0] - a[0])
    size = 5
    d.add(Polygon([b[0], b[1], b[0] - size * math.cos(angle - .5), b[1] - size * math.sin(angle - .5), b[0] - size * math.cos(angle + .5), b[1] - size * math.sin(angle + .5)], fillColor=color, strokeColor=color))


def architecture(cloud=False):
    d = Drawing(468, 405)
    columns = [5, 169, 333]
    def node(col, y, title, lines, prepared=False):
        x = columns[col]
        d.add(Rect(x, y, 130, 55, rx=4, fillColor=colors.HexColor("#eef5f8") if prepared else colors.HexColor("#f5f7f9"), strokeColor=colors.HexColor("#92a4af"), strokeWidth=.8, strokeDashArray=[4, 3] if prepared else None))
        text(d, x + 65, y + 37, title, 10.5, True, anchor="middle")
        for index, line in enumerate(lines):
            text(d, x + 65, y + 23 - index * 12, line, 9.3, anchor="middle")
    node(0, 335, "Browser interfaces", ["Subscriber page", "Administrator dashboard"])
    node(1, 335, "Functions API" if cloud else "Local API", ["Subscription and campaign", "management"], cloud)
    node(2, 335, "Cosmos DB" if cloud else "Private local files", ["Campaigns and outcomes", "Subscription records"], cloud)
    node(0, 235, "Campaign queue", ["Service Bus" if cloud else "Persistent local queue", "Campaign identifiers"], cloud)
    node(1, 235, "Fan out function" if cloud else "Fan out worker", ["Frozen audience", "25 recipients per page"], cloud)
    node(2, 235, "Delivery queue", ["Service Bus" if cloud else "Persistent local queue", "Delivery identifiers"], cloud)
    node(0, 135, "Timer and recovery", ["Due schedules", "Pending work and retries"], cloud)
    node(1, 135, "Delivery function" if cloud else "Push worker", ["Payload encryption", "VAPID request signing"], cloud)
    node(2, 135, "Browser push service", ["Subscription endpoint", "Provider acceptance"])
    node(2, 35, "Service worker", ["Notification creation", "Receipt and click reports"])
    arrow(d, [(135, 362), (169, 362)])
    arrow(d, [(299, 362), (333, 362)])
    arrow(d, [(234, 335), (234, 315), (70, 315), (70, 290)])
    arrow(d, [(135, 262), (169, 262)])
    arrow(d, [(299, 262), (333, 262)])
    arrow(d, [(398, 235), (398, 215), (234, 215), (234, 190)])
    arrow(d, [(70, 190), (70, 235)])
    arrow(d, [(299, 162), (333, 162)])
    arrow(d, [(398, 135), (398, 90)])
    text(d, 10, 78, "Dashed boxes are prepared Azure components." if cloud else "API and workers share one local Node process.", 9.5)
    text(d, 10, 62, "Azure and Entra verification remains pending." if cloud else "Document and queue state persists in private files.", 9.5)
    text(d, 10, 46, "This topology has not been deployed." if cloud else "Receipt and click reports return through the API.", 9.5)
    return d


def panel(d, y, metric, label, workers=2, scale=1, x=58, width=390, height=116):
    rows = [row for row in DATA["samples"] if not row["warmup"] and row["concurrency"] == workers]
    audiences = DATA["measurement"]["plan"]["audiences"]
    maximum = max(row[metric] / scale for row in rows) * 1.15
    maximum = max(1, maximum)
    chart = LinePlot()
    chart.x = x; chart.y = y; chart.width = width; chart.height = height
    chart.xValueAxis.valueMin = .95; chart.xValueAxis.valueMax = 3.05
    chart.xValueAxis.valueSteps = [1, 2, 3]
    chart.xValueAxis.labelTextFormat = lambda value: str(int(10 ** value))
    chart.xValueAxis.labels.fontName = "Helvetica"; chart.xValueAxis.labels.fontSize = 9.5
    chart.yValueAxis.valueMin = 0; chart.yValueAxis.valueMax = maximum
    chart.yValueAxis.valueSteps = [maximum * index / 4 for index in range(5)]
    chart.yValueAxis.labelTextFormat = lambda value: f"{value:,.0f}"
    chart.yValueAxis.labels.fontName = "Helvetica"; chart.yValueAxis.labels.fontSize = 9
    chart.yValueAxis.visibleGrid = True; chart.yValueAxis.gridStrokeColor = GRAY
    chart.yValueAxis.gridStrokeWidth = .4
    series = []
    for condition in ["fresh-process", "reused-process"]:
        values = []
        for audience in audiences:
            selected = sorted(row[metric] / scale for row in rows if row["condition"] == condition and row["audience"] == audience)
            values.append((math.log10(audience), selected[(len(selected) - 1) // 2]))
        series.append(values)
    chart.data = series
    chart.lines[0].strokeColor = ORANGE; chart.lines[1].strokeColor = BLUE
    chart.lines.strokeWidth = 1.5
    d.add(chart)
    for row in rows:
        point_x = chart.x + (math.log10(row["audience"]) - .95) / 2.1 * chart.width + (-2 if row["condition"] == "fresh-process" else 2)
        point_y = y + row[metric] / scale / maximum * chart.height
        d.add(Circle(point_x, point_y, 2.2, fillColor=ORANGE if row["condition"] == "fresh-process" else BLUE, strokeColor=colors.white, strokeWidth=.25))
    text(d, x, y + height + 16, label, 10.5, True)
    text(d, x + width / 2, y - 30, "Recipients" if width < 200 else "Synthetic recipients per trial", 9.5, anchor="middle")


def comparison(resources=False):
    if resources:
        d = Drawing(468, 205)
        panel(d, 50, "cpuMs", "Child CPU including seeding ms", x=44, width=175, height=105)
        panel(d, 50, "rssAfterBytes", "RSS after processing MiB", scale=1048576, x=282, width=166, height=105)
        text(d, 44, 190, "Fresh processes", 9.5, color=ORANGE)
        text(d, 220, 190, "Reused after warm up", 9.5, color=BLUE)
        return d
    d = Drawing(468, 375)
    panel(d, 220, "cpuMs" if resources else "acceptedPerSecond", "Child CPU including seeding in ms" if resources else "Mock acceptances per second")
    panel(d, 44, "rssAfterBytes" if resources else "endToEndP95Ms", "RSS after processing in MiB not peak" if resources else "Per trial p95 end to end in ms", scale=1048576 if resources else 1)
    text(d, 60, 365, "Fresh processes", 9.5, color=ORANGE)
    text(d, 210, 365, "Reused after warm up", 9.5, color=BLUE)
    return d


def startup():
    d = Drawing(468, 165)
    groups = [[row["ms"] for row in DATA["startups"] if row["audience"] == 100 and row["concurrency"] == 2 and row["condition"] == condition] for condition in ["fresh-process", "reused-process"]]
    maximum = max(max(values) for values in groups) * 1.25
    d.add(Line(52, 40, 448, 40, strokeColor=colors.black, strokeWidth=.7))
    for index in range(5):
        y = 40 + index * 24
        d.add(Line(52, y, 448, y, strokeColor=GRAY, strokeWidth=.4))
        text(d, 44, y - 3, f"{maximum * index / 4:.0f}", 9, anchor="end")
    for index, values in enumerate(groups):
        x = 150 + index * 200; color = [ORANGE, BLUE][index]
        for offset, value in enumerate(values):
            d.add(Circle(x + (offset - (len(values)-1)/2) * 7, 40 + value / maximum * 96, 3, fillColor=color, strokeColor=color))
        median = sorted(values)[(len(values) - 1) // 2]
        d.add(Line(x - 35, 40 + median / maximum * 96, x + 35, 40 + median / maximum * 96, strokeColor=color, strokeWidth=1.4))
        text(d, x, 21, "Fresh per repetition" if index == 0 else "Once before reused trials", 9.5, anchor="middle")
        text(d, x, 5, f"n = {len(values)}", 9.3, anchor="middle")
    text(d, 52, 151, "Child readiness in ms at audience 100 and two workers", 10.5, True)
    return d


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    drawings = {"local-architecture": architecture(), "prepared-azure-architecture": architecture(True), "performance-two-workers": comparison(), "resources-two-workers": comparison(True), "process-startup": startup()}
    for name, drawing in drawings.items():
        renderSVG.drawToFile(drawing, str(OUT / f"{name}.svg"))
    print(f"Saved {len(drawings)} document-sized SVG figures.")
