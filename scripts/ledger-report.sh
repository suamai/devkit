#!/bin/sh
# Read ~/.claude/devkit/runs.jsonl and print the calibration checklist from docs/architecture.md
# with real numbers — the only thing that turns the run ledger into something a human can act on.
#
# Why a script rather than a model reading the file: the numbers have to be arithmetic, not
# estimates, and no agent may read raw ledger lines. Aggregates can reach a conversation; the lines
# behind them never do. That is what keeps the ledger telemetry instead of the uncurated cross-cycle
# memory this project rejected (docs/architecture.md → "No shared memory across cycles").
#
# No node, no jq — the same stance as hooks/session-start-stale-flows.sh: this ships into every repo
# that installs the plugin and can assume neither. Parsing is per-key extraction over one line at a
# time, sound only because the line has ONE writer and a documented shape: every string-valued field
# is top-level, and the only sub-objects (`cost`, `findings`, `verification`) hold numbers, booleans
# and one nested `by_phase`. A line that yields no `phase` is not guessed at — it is skipped and
# counted out loud, so a reader that quietly stopped reading shows up as a number instead of as a
# smaller sample nobody notices.
#
# Medians, never means: one 300k run must not become everybody's average. Every row carries its
# sample size, and a row with no samples prints `n=0 — no data` rather than a confident zero.
#
# Usage: ledger-report.sh
#            the calibration checklist, one section per row of docs/architecture.md
#
#        ledger-report.sh --quote --phase <p> [--tier <t>] [--profile <p>]
#            ONE line for /dev-plan to paste at its approval checkpoint. Comparable means same
#            phase + same tier + same profile, across EVERY repo — the ledger is per developer and
#            spans repos by design, so a same-repo key would read n=0 for months in a new repo and
#            no --repo filter exists. An absent --tier or --profile widens the query instead of
#            filtering on absence; a line with no `profile` counts as the shipped default, because
#            the contract only records that field when it was overridden. Fewer than 3 matches
#            refuses to quote a median instead of backing one with two samples.
mode=report
q_phase=
q_tier=
q_profile=

usage() {
  printf 'usage: ledger-report.sh\n       ledger-report.sh --quote --phase <p> [--tier <t>] [--profile <p>]\n' >&2
}

while [ $# -gt 0 ]; do
  case $1 in
    --quote) mode=quote ;;
    --phase|--tier|--profile)
      [ $# -ge 2 ] || { printf 'ledger-report.sh: %s needs a value\n' "$1" >&2; exit 2; }
      case $1 in
        --phase) q_phase=$2 ;;
        --tier) q_tier=$2 ;;
        --profile) q_profile=$2 ;;
      esac
      shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'ledger-report.sh: unknown argument "%s"\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [ "$mode" = quote ]; then
  [ -n "$q_phase" ] || { printf 'ledger-report.sh: --quote needs --phase <p>\n' >&2; exit 2; }
else
  # Filtering without --quote would print a whole checklist over a subset while every label still
  # said otherwise — a wrong number that looks like a right one.
  [ -z "$q_phase$q_tier$q_profile" ] || { printf 'ledger-report.sh: --phase/--tier/--profile only apply to --quote\n' >&2; exit 2; }
fi

display='~/.claude/devkit/runs.jsonl'
ledger="$HOME/.claude/devkit/runs.jsonl"

if [ ! -f "$ledger" ]; then
  # Not an error: the file appears the first time a phase runs. --quote answers in its own single
  # line, because /dev-plan pastes that line verbatim and a paragraph would land in the report.
  if [ "$mode" = quote ]; then
    printf 'n=0 comparable runs\n'
  else
    printf 'no ledger yet at %s — it is written by the phase skills; run any phase to start one\n' "$display"
  fi
  exit 0
fi

awk -v mode="$mode" -v qphase="$q_phase" -v qtier="$q_tier" -v qprofile="$q_profile" -v display="$display" '
# ---------------------------------------------------------------- reading one line

function isnum(v) { return v ~ /^-?[0-9]+(\.[0-9]+)?$/ }

function hexval(ch) { return index("0123456789abcdef", tolower(ch)) - 1 }

# UTF-8 encoding of a codepoint, built by hand from its constituent bytes rather than via
# sprintf("%c", cp): a numeric argument above 127 is not portable across awk implementations —
# gawk in a UTF-8 locale treats it as a codepoint and emits the multi-byte encoding, while mawk
# (the traditional, non-gawk default awk) truncates it to value-mod-256 and emits one raw byte.
# bytechar() instead indexes HI, a table of the 128 possible high bytes written as octal string
# escapes (\200..\377): the awk lexer inserts each literal byte value with no locale or codepoint
# reinterpretation in either implementation, verified byte-identical against a mawk build in
# addition to gawk. A lone surrogate half (no pairing support here) falls back to "?" rather than
# risk an invalid character — a placeholder is honest, mangled bytes are not.
function bytechar(v) { return substr(HI, v - 127, 1) }
function utf8(cp) {
  if (cp >= 55296 && cp <= 57343) return "?"
  if (cp < 128) return sprintf("%c", cp)
  if (cp < 2048) return bytechar(int(cp / 64) + 192) bytechar(cp % 64 + 128)
  return bytechar(int(cp / 4096) + 224) bytechar(int(cp / 64) % 64 + 128) bytechar(cp % 64 + 128)
}

function unq(v,   out, i, n, c, h1, h2, h3, h4, cp) {
  if (substr(v, 1, 1) != "\"") return v
  v = substr(v, 2, length(v) - 2)
  n = length(v); out = ""
  for (i = 1; i <= n; i++) {
    c = substr(v, i, 1)
    if (c == "\\") {
      i++; c = substr(v, i, 1)
      if (c == "n" || c == "t" || c == "r") c = " "
      else if (c == "u") {
        h1 = hexval(substr(v, i + 1, 1)); h2 = hexval(substr(v, i + 2, 1))
        h3 = hexval(substr(v, i + 3, 1)); h4 = hexval(substr(v, i + 4, 1))
        if (h1 >= 0 && h2 >= 0 && h3 >= 0 && h4 >= 0) {
          cp = h1 * 4096 + h2 * 256 + h3 * 16 + h4
          c = utf8(cp)
          i += 4
        } else {
          c = "?"
        }
      }
    }
    out = out c
  }
  return out
}

# Split ONE JSON object into its TOP-LEVEL keys: F[key] = value (strings unquoted, numbers and
# booleans as text, sub-objects as their raw {...} text — feed those back through here). O[1..n]
# keeps document order so the report is stable whatever the awk implementation does with `in`.
# Returns the number of keys found; 0 also means "not shaped like an object", which is the only
# distinction this reader needs. Depth and quote tracking is what keeps a key inside `cost.by_phase`
# from being read as a top-level field of the same name.
function parse(s, F, O,   i, n, c, key, d, inq, esc, start, val, nk) {
  n = length(s); nk = 0
  i = index(s, "{")
  if (i == 0) return 0
  i++
  while (i <= n) {
    c = substr(s, i, 1)
    while (i <= n && (c == " " || c == "\t" || c == ",")) { i++; c = substr(s, i, 1) }
    if (i > n || c == "}") break
    if (c != "\"") return nk
    i++; key = ""
    while (i <= n) {
      c = substr(s, i, 1)
      if (c == "\\") { key = key substr(s, i + 1, 1); i += 2; continue }
      i++
      if (c == "\"") break
      key = key c
    }
    while (i <= n && (substr(s, i, 1) == " " || substr(s, i, 1) == "\t")) i++
    if (substr(s, i, 1) != ":") return nk
    i++
    while (i <= n && (substr(s, i, 1) == " " || substr(s, i, 1) == "\t")) i++
    start = i
    c = substr(s, i, 1)
    if (c == "\"") {
      i++
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\\") { i += 2; continue }
        i++
        if (c == "\"") break
      }
      F[key] = unq(substr(s, start, i - start))
    } else if (c == "{" || c == "[") {
      d = 0; inq = 0; esc = 0
      while (i <= n) {
        c = substr(s, i, 1)
        if (inq) {
          if (esc) esc = 0
          else if (c == "\\") esc = 1
          else if (c == "\"") inq = 0
          i++
          continue
        }
        if (c == "\"") { inq = 1; i++; continue }
        if (c == "{" || c == "[") d++
        else if (c == "}" || c == "]") { d--; if (d == 0) { i++; break } }
        i++
      }
      F[key] = substr(s, start, i - start)
    } else {
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "," || c == "}") break
        i++
      }
      val = substr(s, start, i - start)
      sub(/[ \t]+$/, "", val)
      F[key] = val
    }
    O[++nk] = key
  }
  return nk
}

# ---------------------------------------------------------------- samples and medians

function reg(g, k) { if (!((g, k) in seen)) { seen[g, k] = 1; ord[g, ++nord[g]] = k } }
function push(g, k, v) { reg(g, k); vals[g, k, ++cnt[g, k]] = v + 0 }
function bump(g, k) { reg(g, k); hc[g, k]++ }

# POSIX awk has no asort, so the sort is here: insertion sort over a local copy. n is small (one
# entry per run), and a median needs the whole sample anyway.
function med(g, k,   n, i, j, t, a) {
  n = cnt[g, k]
  if (n == 0) return ""
  for (i = 1; i <= n; i++) a[i] = vals[g, k, i] + 0
  for (i = 2; i <= n; i++) { t = a[i]; j = i - 1; while (j >= 1 && a[j] > t) { a[j + 1] = a[j]; j-- } a[j + 1] = t }
  if (n % 2 == 1) return a[int((n + 1) / 2)]
  return (a[int(n / 2)] + a[int(n / 2) + 1]) / 2
}

function kfmt(v,   k) { k = v / 1000; if (k >= 10 || k == int(k)) return sprintf("%dk", int(k + 0.5)); return sprintf("%.1fk", k) }
function nfmt(v) { if (v == int(v)) return sprintf("%d", v); return sprintf("%.1f", v) }
function hist(g,   i, k, out) {
  out = ""
  for (i = 1; i <= nord[g]; i++) { k = ord[g, i]; out = out (i > 1 ? " " : "") k "×" hc[g, k] }
  return out
}

# ---------------------------------------------------------------- one ledger line

function handle(line,   F, O, C, CO, B, BO, FI, FO, VE, VO, phase, tier, profile, conc, tot, floor, agents, i, k) {
  if (line ~ /^[ \t]*$/) return
  if (parse(line, F, O) == 0 || F["phase"] == "") { bad++; return }
  ok++
  phase = F["phase"]
  tier = F["tier"]
  # Omitted `profile` means the shipped default: the contract records it only when overridden.
  profile = F["profile"]; if (profile == "") profile = "default"
  conc = F["concurrent"]; if (conc == "") conc = "unknown"

  if (F["findings"] != "" && parse(F["findings"], FI, FO) > 0) {
    if (isnum(FI["raw_titles"]) && isnum(FI["clusters"])) {
      cl_raw += FI["raw_titles"]; cl_clu += FI["clusters"]; cl_n++
    }
  }

  if (F["verification"] != "" && parse(F["verification"], VE, VO) > 0) {
    if (isnum(VE["unverified_honest"]) || isnum(VE["unverified_unevidenced"]) || isnum(VE["unverified_infra"])) {
      uv_n++
      if (isnum(VE["unverified_honest"])) uv_h += VE["unverified_honest"]
      if (isnum(VE["unverified_unevidenced"])) uv_u += VE["unverified_unevidenced"]
      if (isnum(VE["unverified_infra"])) uv_i += VE["unverified_infra"]
      if (isnum(VE["steps"])) uv_steps += VE["steps"]
    }
  }

  tot = ""
  if (F["cost"] != "" && parse(F["cost"], C, CO) > 0) {
    if (isnum(C["total"]) && C["total"] + 0 > 0) {
      tot = C["total"] + 0
      tok_n++
      if (conc != "false") tok_conc++
      push("ph", phase, tot)
      # Keyed by phase too, not tier alone: plan-phase and implement-phase costs sit at wholly
      # different magnitudes, and both now carry `tier` — a bare tier= bucket would blend them into
      # a median that represents neither population.
      if (tier != "") push("ti", phase ":" tier, tot)
      push("pr", profile, tot)
    }
    if (C["by_phase"] != "") {
      # `> 0` mirrors costReport() itself, which treats a zero as a phase that did not happen:
      # counting those zeros as samples would drag every median of that key toward nothing.
      k = parse(C["by_phase"], B, BO)
      for (i = 1; i <= k; i++) if (isnum(B[BO[i]]) && B[BO[i]] + 0 > 0) push("bp", BO[i], B[BO[i]] + 0)
    }
  }

  if (isnum(F["rounds"]) && F["clean"] == "true") {
    k = int(F["rounds"]); rc_h[k]++; rc_n++; if (k > rc_max) rc_max = k
  }
  if (F["rounds_end"] != "") { bump("re", F["rounds_end"]); re_n++ }

  if (phase == "plan") {
    if (tier != "") { es_n++; if (tier != "trivial" && tier != "small") es_up++ }
    if (F["signal"] != "") { bump("sig", F["signal"]); sig_n++ }
  }

  # The SAME floor wf-implement.js computes for agents_min (scouts + one implementer per step +
  # gates + ~4 per review checkpoint + the final consistency check), recomputed from what the run
  # actually did. Both sides are floors, so their delta is what the plan did not foresee.
  floor = ""
  if (isnum(F["scouts_ran"]) && isnum(F["steps_leaf"]) && isnum(F["gates"]) && isnum(F["checkpoints"]))
    floor = F["scouts_ran"] + F["steps_leaf"] + F["gates"] + F["checkpoints"] * 4 + 1

  if (phase == "implement") {
    if (isnum(F["splits"]) && isnum(F["steps_leaf"])) { sp_s += F["splits"]; sp_t += F["steps_leaf"]; sp_n++ }
    if (isnum(F["agents_projected"])) push("ag", "projected", F["agents_projected"] + 0)
    if (floor != "") push("ag", "floor", floor)
  }

  if (mode == "quote") {
    if (phase != qphase) return
    if (qtier != "" && tier != qtier) return
    if (qprofile != "" && profile != qprofile) return
    qn++
    if (tot != "") push("q", "tokens", tot)
    agents = (floor != "") ? floor : (isnum(F["agents_projected"]) ? F["agents_projected"] + 0 : "")
    if (agents != "") push("q", "agents", agents)
  }
}

# ---------------------------------------------------------------- output

function norow(label) { printf "%-29s n=0 — no data\n", label }
function row(label, n, text) { if (n == 0) norow(label); else printf "%-29s n=%-4d %s\n", label, n, text }
function cont(n, text) { if (n == "") printf "%-29s       %s\n", "", text; else printf "%-29s n=%-4d %s\n", "", n, text }

function tokens(   i, k, c) {
  if (tok_n == 0) { norow("6. Tokens per phase"); return }
  printf "%s\n", "6. Tokens per phase — median cost.total, output tokens"
  # One shared field width across every row kind in this block, sized to the worst-case composite
  # label below ("phase=implement tier=trivial" = 28 chars) — not a per-kind width, or the n=
  # column drifts between row kinds even though they all belong to the same visual block.
  for (i = 1; i <= nord["ph"]; i++) { k = ord["ph", i]; printf "     %-32s n=%-4d %s\n", "phase=" k, cnt["ph", k], kfmt(med("ph", k)) }
  # k is "<phase>:<tier>" (see push("ti", ...) in handle()) so a tier bucket never loses which
  # phase it came from — phase and tier are both closed enums with no ":" in either.
  for (i = 1; i <= nord["ti"]; i++) { k = ord["ti", i]; c = index(k, ":"); printf "     %-32s n=%-4d %s\n", "phase=" substr(k, 1, c - 1) " tier=" substr(k, c + 1), cnt["ti", k], kfmt(med("ti", k)) }
  for (i = 1; i <= nord["pr"]; i++) { k = ord["pr", i]; printf "     %-32s n=%-4d %s\n", "profile=" k, cnt["pr", k], kfmt(med("pr", k)) }
  for (i = 1; i <= nord["bp"]; i++) { k = ord["bp", i]; printf "     %-32s n=%-4d %s\n", "by_phase=" k, cnt["bp", k], kfmt(med("bp", k)) }
}

function agentsrow(   np, nf) {
  np = cnt["ag", "projected"]; nf = cnt["ag", "floor"]
  if (np == 0 && nf == 0) { norow("7. Projected vs actual agents"); return }
  printf "%s\n", "7. Projected vs actual agents — implement runs, both floors, same formula"
  if (np == 0) printf "     %-24s n=0   no data\n", "projected"
  else printf "     %-24s n=%-4d %s\n", "projected by the plan", np, nfmt(med("ag", "projected"))
  if (nf == 0) printf "     %-24s n=0   no data\n", "observed floor"
  else printf "     %-24s n=%-4d %s\n", "observed floor", nf, nfmt(med("ag", "floor"))
  printf "     %s\n", "the delta is what the plan did not foresee: splits, gate-forced checkpoints, extra rounds"
}

function convergence(   i, out) {
  out = ""
  for (i = 0; i <= rc_max; i++) if (rc_h[i] > 0) out = out (out == "" ? "" : " ") i "×" rc_h[i]
  row("3. Round convergence", rc_n, "rounds to clean: " out)
  if (re_n > 0) cont(re_n, "ended: " hist("re"))
}

function report(   i) {
  if (ok == 0 && bad == 0) { printf "ledger at %s is empty — no phase has recorded a run yet\n", display; return }
  printf "devkit calibration — %d ledger line(s) from %s\n", ok, display
  if (bad > 0) printf "%d line(s) skipped as unreadable\n", bad
  printf "\n"

  if (cl_n == 0) norow("1. Clustering ratio")
  else if (cl_clu == 0) row("1. Clustering ratio", cl_n, sprintf("%d raw titles, 0 clusters", cl_raw))
  else row("1. Clustering ratio", cl_n, sprintf("%.2f raw titles per semantic cluster (%d raw / %d clusters)", cl_raw / cl_clu, cl_raw, cl_clu))

  if (sp_n == 0 || sp_t == 0) norow("2. Split rate")
  else row("2. Split rate", sp_n, sprintf("%.2f (%d splits / %d leaf steps)", sp_s / sp_t, sp_s, sp_t))

  convergence()

  if (es_n == 0) norow("4. Escalation rate")
  else row("4. Escalation rate", es_n, sprintf("%d%% went past small (%d/%d)", int(100 * es_up / es_n + 0.5), es_up, es_n))
  if (sig_n > 0) cont(sig_n, "signals: " hist("sig"))

  if (uv_n == 0) norow("5. Unverified steps")
  else {
    row("5. Unverified steps", uv_n, sprintf("honest %d, unevidenced %d, infra %d, over %d steps", uv_h, uv_u, uv_i, uv_steps))
    cont("", "(unevidenced is the prompt-calibration signal and should be 0; infra blames nobody)")
  }

  tokens()
  agentsrow()

  printf "\n%s\n", "Caveats"
  printf "  %s\n", "- wf-implement `steps` covers scouting and implementation together: agents in a wave"
  printf "  %s\n", "  interleave, so no delta can attribute tokens to one or the other."
  printf "  %s\n", "- budget.spent() is the whole turn output-token count, shared with the main loop and any"
  printf "  %s\n", "  other workflow, so a second workflow running at the same time inflates these and nothing"
  printf "  %s\n", "  in the script can detect it. Measure with one run at a time."
  if (tok_n > 0)
    printf "  %s\n", sprintf("  %d of %d token samples ran with concurrent true or unknown — their cost.by_phase may be inflated.", tok_conc, tok_n)
  printf "  %s\n", "- Medians, never means, and every row carries its n. Calibration input, not targets."
}

function quote(   nt, na, t, a) {
  if (qn == 0) { printf "n=0 comparable runs\n"; return }
  if (qn < 3) { printf "n=%d — sample too small to quote (need 3)\n", qn; return }
  nt = cnt["q", "tokens"]; na = cnt["q", "agents"]
  t = (nt > 0) ? sprintf("median %s output tokens", kfmt(med("q", "tokens"))) : "output tokens unknown"
  a = (na > 0) ? sprintf("median %s agents (floor)", nfmt(med("q", "agents"))) : "agents unknown"
  printf "n=%d comparable runs: %s, %s\n", qn, t, a
}

BEGIN {
  # The 128 raw bytes 0x80..0xFF that bytechar() indexes into — see utf8() above for why these are
  # octal string escapes rather than sprintf("%c", n).
  HI = "\200\201\202\203\204\205\206\207\210\211\212\213\214\215\216\217\220\221\222\223\224\225\226\227\230\231\232\233\234\235\236\237\240\241\242\243\244\245\246\247\250\251\252\253\254\255\256\257\260\261\262\263\264\265\266\267\270\271\272\273\274\275\276\277\300\301\302\303\304\305\306\307\310\311\312\313\314\315\316\317\320\321\322\323\324\325\326\327\330\331\332\333\334\335\336\337\340\341\342\343\344\345\346\347\350\351\352\353\354\355\356\357\360\361\362\363\364\365\366\367\370\371\372\373\374\375\376\377"
}
{ handle($0) }
END { if (mode == "quote") quote(); else report() }
' "$ledger"
