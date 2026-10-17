# Codebase size

Snapshot of tracked application source on 2026-10-15, at commit `dafffe7e`.
The backend is `src/`; the frontend is `dashboard/src/`, matching the ownership
boundary in [Architecture](architecture.md).

| Area | Files | Source lines | Nonblank lines |
| --- | ---: | ---: | ---: |
| Backend | 461 | 109,646 | 103,824 |
| Frontend | 144 | 36,442 | 34,621 |
| **Total** | **605** | **146,088** | **138,445** |

Source lines count physical lines in tracked TypeScript, TSX, JavaScript, JSX,
CSS, SCSS, HTML, and SQL files under those directories. Nonblank lines omit
empty or whitespace-only lines but still include comments. Tests, generated
assets, dependencies, scripts, migrations outside `src/`, and documentation
are not included. These are repository-size estimates, not language-aware
logical LOC; rerun the count after source changes for an updated snapshot.

To reproduce:

```sh
for area in src dashboard/src; do
  files=$(git ls-files "$area" | grep -E '\.(ts|tsx|js|jsx|css|scss|html|sql)$')
  echo "$area files=$(echo "$files" | wc -l)" \
       "lines=$(echo "$files" | xargs wc -l | tail -1 | awk '{print $1}')" \
       "nonblank=$(echo "$files" | xargs grep -cvE '^\s*$' | awk -F: '{s+=$2} END {print s}')"
done
```
