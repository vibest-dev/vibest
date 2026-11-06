
import glob
import json
import os
import re
import sys

dir, status = sys.argv[1], int(sys.argv[2])
runs = {}
elapsed = {}
output = {}
for line in open(os.path.join(dir, "test.json")):
    e = json.loads(line)
    t = e.get("Test")
    if not t:
        continue
    if e["Action"] in ("pass", "fail", "skip"):
        runs.setdefault(t, []).append(e["Action"])
        elapsed[t] = e.get("Elapsed", 0)
    elif e["Action"] == "output":
        output.setdefault(t, []).append(e["Output"])

UNITS = {"ns": 1e-6, "µs": 1e-3, "us": 1e-3, "ms": 1, "s": 1e3, "m": 6e4}
DUR = re.compile(r"(\d+(?:\.\d+)?)(ns|µs|us|ms|s|m)")


def ms(text):
    total = 0.0
    for n, unit in DUR.findall(text):
        total += float(n) * UNITS[unit]
    return total


metrics = {}
for t, lines in output.items():
    for line in lines:
        m = re.match(r"\s+\S+_test\.go:\d+: ([CTPUW]\d+[^:]*?):? (\d[\d.]*(?:ns|µs|us|ms|s|m)(?:[\d.]+(?:ms|s))?)\s*$", line)
        if m:
            metrics[m.group(1)] = ms(m.group(2))

previous = {}
for d in sorted(glob.glob(os.path.join(os.path.dirname(dir), "*", "metrics.json"))):
    if os.path.dirname(d) != dir:
        previous = json.load(open(d))
json.dump(metrics, open(os.path.join(dir, "metrics.json"), "w"), indent=1, ensure_ascii=False)

rows, failed, flaky = [], [], []
for t in sorted(runs, key=lambda t: (t.split("/")[0], t)):
    r = runs[t]
    if r[-1] == "fail":
        verdict = "FAIL"
        failed.append(t)
    elif "fail" in r:
        verdict = "FLAKY"
        flaky.append(t)
    else:
        verdict = r[-1].upper()
    rows.append(f"| {t} | {verdict} | {elapsed[t]:.2f}s |")

out = [f"# e2e {os.path.basename(dir)}", ""]
out.append(f"go test exit {status}; {len(rows)} tests, {len(failed)} failed, {len(flaky)} flaky.")
out += ["", "| test | result | time |", "|---|---|---|"] + rows
out += ["", "## Numbers", "", "| what | ms | previous | change |", "|---|---|---|---|"]
for k in sorted(metrics):
    v, p = metrics[k], previous.get(k)
    change = ""
    if p:
        pct = (v - p) / p * 100
        change = f"{pct:+.0f}%" + (" **slower by over 20%**" if pct > 20 else "")
    out.append(f"| {k} | {v:.1f} | {'' if p is None else f'{p:.1f}'} | {change} |")
for t in failed + flaky:
    out += ["", f"## {t}", "", "```", "".join(output.get(t, []))[-6000:], "```"]
open(os.path.join(dir, "report.md"), "w").write("\n".join(out) + "\n")
