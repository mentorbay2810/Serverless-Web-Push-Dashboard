"""Render local research evidence with Matplotlib; never fetch data or cloud pricing."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform

PROJECT = Path(__file__).resolve().parents[2]
os.environ.setdefault("MPLCONFIGDIR", str(PROJECT / ".cache/matplotlib"))
os.environ.setdefault("XDG_CACHE_HOME", str(PROJECT / ".cache"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import NullFormatter, NullLocator


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_verified(directory):
    evidence = json.loads((directory / "evidence.json").read_text())
    derived = json.loads((directory / "analysis-files.json").read_text())
    for manifest in (evidence, derived):
        for item in manifest["files"]:
            path = directory / item["path"]
            if path.is_absolute() and not path.resolve().is_relative_to(directory):
                raise ValueError("Evidence path escapes the experiment.")
            if ".." in Path(item["path"]).parts or any(parent.is_symlink() for parent in [path, *path.parents] if parent != directory.parent):
                raise ValueError("Evidence must use regular local paths.")
            if digest(path) != item["sha256"]:
                raise ValueError("Evidence changed. Run research:analyze -- <directory> --verify.")
    data = json.loads((directory / "analysis.json").read_text())
    if data["status"] != "local_analysis_passed" or data["evidenceManifestSha256"] != digest(directory / "evidence.json"):
        raise ValueError("Incomplete or mismatched local analysis.")
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    directory = args.directory.resolve()
    data = load_verified(directory)
    figures = directory / "figures"
    figures.mkdir(exist_ok=True)
    colors = {"fresh-process": "#c05a30", "reused-process": "#167b8a"}
    labels = {"fresh-process": "Fresh processes", "reused-process": "Reused after warm-up"}
    measured = [row for row in data["samples"] if not row["warmup"]]
    audiences = sorted(data["plan"]["audiences"])
    concurrencies = sorted(data["plan"]["concurrencies"])
    conditions = ["fresh-process", "reused-process"]
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                         "axes.titlesize": 12, "axes.labelsize": 10, "svg.fonttype": "none", "savefig.facecolor": "white"})
    outputs = []

    def save(fig, name):
        for extension in ("png", "svg"):
            path = figures / f"{name}.{extension}"
            fig.savefig(path, dpi=180)
            outputs.append({"path": str(path.relative_to(directory)), "sha256": digest(path)})
        plt.close(fig)

    height = 3.1 * len(concurrencies) + 1.8
    fig, axes = plt.subplots(len(concurrencies), 2, figsize=(11, height), squeeze=False)
    for index, workers in enumerate(concurrencies):
        for column, (metric, ylabel) in enumerate((("acceptedPerSecond", "Mock acceptances / second"), ("endToEndP95Ms", "Per-trial p95 end-to-end (ms)"))):
            ax = axes[index, column]
            for condition in conditions:
                values, lows, highs = [], [], []
                for audience in audiences:
                    samples = [row[metric] for row in measured if row["audience"] == audience and row["concurrency"] == workers and row["condition"] == condition]
                    ordered = sorted(samples)
                    median = ordered[(len(ordered) - 1) // 2]
                    values.append(median); lows.append(min(samples)); highs.append(max(samples))
                    offset = .97 if condition == "fresh-process" else 1.03
                    ax.scatter([audience * offset] * len(samples), samples, s=22, alpha=.65, color=colors[condition], edgecolors="white", linewidths=.3, zorder=3)
                ax.plot(audiences, values, marker="o", linewidth=1.8, color=colors[condition], label=labels[condition])
                ax.fill_between(audiences, lows, highs, color=colors[condition], alpha=.1)
            ax.set_xscale("log")
            ax.set_xticks(audiences, [str(value) for value in audiences])
            ax.xaxis.set_minor_formatter(NullFormatter()); ax.xaxis.set_minor_locator(NullLocator())
            if len(audiences) == 1:
                ax.set_xlim(audiences[0] * .8, audiences[0] * 1.25)
            ax.set_xlabel("Synthetic recipients per trial")
            ax.set_ylabel(ylabel)
            ax.set_title(f"{workers} delivery worker{'s' if workers != 1 else ''}", loc="left")
            ax.set_ylim(bottom=0)
            ax.grid(axis="y", color="#dde3e8", linewidth=.6)
    axes[0, 0].legend(frameon=False, loc="best", fontsize=9)
    fig.suptitle("Local pipeline measurements", x=.08, ha="left", va="top", fontsize=19, fontweight="bold", y=1-.2/height)
    fig.text(.08, 1-.66/height, f"Memory adapters · phased fan-out · {data['plan']['mockDelayMs']} ms requested mock delay", va="top", fontsize=10, color="#485563")
    fig.text(.08, .12/height, "Dots: measured trials. Lines: medians. Shading: observed min–max, not confidence intervals.\nFresh/reused changes both driver/mock and child host. Local results do not establish Azure performance.", va="bottom", fontsize=9, color="#485563")
    fig.subplots_adjust(left=.08, right=.97, bottom=1.05/height, top=1-1.2/height, hspace=.65, wspace=.26)
    save(fig, "performance")

    workers = 2 if 2 in concurrencies else concurrencies[0]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.7))
    for ax, metric, ylabel in ((axes[0], "cpuMs", "Child CPU time (ms), including seeding"), (axes[1], "rssAfterBytes", "RSS after processing (MiB), not peak")):
        for condition in conditions:
            values = []
            for audience in audiences:
                samples = [row[metric] / (1024 * 1024 if metric == "rssAfterBytes" else 1) for row in measured if row["audience"] == audience and row["concurrency"] == workers and row["condition"] == condition]
                values.append(sorted(samples)[(len(samples) - 1) // 2])
                ax.scatter([audience] * len(samples), samples, s=22, alpha=.55, color=colors[condition])
            ax.plot(audiences, values, marker="o", color=colors[condition], label=labels[condition])
        ax.set_xscale("log"); ax.set_xticks(audiences, [str(value) for value in audiences])
        ax.xaxis.set_minor_formatter(NullFormatter()); ax.xaxis.set_minor_locator(NullLocator())
        if len(audiences) == 1:
            ax.set_xlim(audiences[0] * .8, audiences[0] * 1.25)
        ax.set_xlabel("Synthetic recipients per trial"); ax.set_ylabel(ylabel); ax.set_ylim(bottom=0)
        ax.grid(axis="y", color="#dde3e8", linewidth=.6)
    axes[0].legend(frameon=False, fontsize=9)
    fig.suptitle(f"Observed child process resources · {workers} worker{'s' if workers != 1 else ''}", x=.08, ha="left", fontsize=16, fontweight="bold")
    fig.text(.08, .025, "Dots: trials; lines: medians. Snapshots and CPU observations are not a price or cloud resource estimate.", fontsize=9, color="#485563")
    fig.subplots_adjust(left=.08, right=.97, bottom=.18, top=.83, wspace=.28)
    save(fig, "resources")

    audience = 100 if 100 in audiences else audiences[0]
    fig, ax = plt.subplots(figsize=(8, 4.7))
    for index, condition in enumerate(conditions):
        samples = [row["ms"] for row in data["startups"] if row["audience"] == audience and row["concurrency"] == workers and row["condition"] == condition]
        ax.scatter([index + (position - (len(samples) - 1) / 2) * .035 for position in range(len(samples))], samples, color=colors[condition], s=45)
        ax.hlines(sorted(samples)[(len(samples) - 1) // 2], index - .22, index + .22, color=colors[condition], linewidth=2)
        ax.text(index, 0, f"n={len(samples)}", ha="center", va="bottom", fontsize=10)
    ax.set_xticks([0, 1], ["Fresh per repetition", "Once before reused trials"]); ax.set_xlim(-.6, 1.6)
    ax.set_ylim(0, max(1, max(row["ms"] for row in data["startups"] if row["audience"] == audience and row["concurrency"] == workers) * 1.25))
    ax.set_ylabel("Child process readiness (ms)"); ax.grid(axis="y", color="#dde3e8", linewidth=.6)
    ax.set_title(f"Local process startup · audience {audience}, workers {workers}", loc="left", fontweight="bold", fontsize=14, pad=20)
    fig.text(.12, .03, "One startup per fresh repetition; one per reused scenario, before its warm-up.\nStartup is excluded from pipeline elapsed time. This does not measure an Azure cold start.", fontsize=9, color="#485563")
    fig.subplots_adjust(left=.12, right=.97, bottom=.21, top=.8)
    save(fig, "startup")
    manifest = {"schemaVersion": 1, "analysisSha256": digest(directory / "analysis.json"), "plotScriptSha256": digest(Path(__file__).resolve()),
                "python": platform.python_version(), "matplotlib": matplotlib.__version__, "files": outputs}
    (figures / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Saved {len(outputs)} verified PNG/SVG figures to {figures}")


if __name__ == "__main__":
    main()
