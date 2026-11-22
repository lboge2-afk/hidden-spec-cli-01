// main.ts is mend, the CLI SPEC.md specifies. It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits, the all-or-nothing write, three-tier line matching
// (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into its line break, its lines and whether it ends with a line break (SPEC.md section 3). */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves performed, as [old, new] pairs, for the R lines of the output (SPEC.md section 2). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of N: a context line (written as the file's own matched line) or an added line. */
type NItem = { kind: 'ctx'; oIdx: number } | { kind: 'add'; text: string };

/** Section 5: whether a file line equals an O line at a tier. */
function lineEqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}
/** Positions where O occurs in `lines` at `tier`, at or after `from`. */
function occurrencesAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const k = O.length;
  if (k === 0) return out;
  for (let i = Math.max(0, from); i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEqAt(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier (0, 1 or 2; only 0 when strict) at which O occurs at or after `from`, or -1. */
function firstTier(lines: string[], O: string[], strict: boolean, from: number): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrencesAt(lines, O, t, from).length > 0) return t;
  }
  return -1;
}
/** Build the lines that replace O at `pos`: context lines from the file, added lines re-indented at tier 2. */
function buildN(fileLines: string[], pos: number, O: string[], items: NItem[], tier: number): string[] {
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const F = leadingWs(fileLines[pos] ?? '');
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + it.oIdx]!);
    } else {
      let s = it.text;
      if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
      out.push(s);
    }
  }
  return out;
}
/** Split a hunk/chunk body into O (context + old lines) and N (context + new lines, as items). */
function bodyON(body: string[]): { O: string[]; N: NItem[] } {
  const O: string[] = [];
  const N: NItem[] = [];
  for (const l of body) {
    if (l === '') {
      O.push('');
      N.push({ kind: 'ctx', oIdx: O.length - 1 });
    } else if (l[0] === ' ') {
      O.push(l.slice(1));
      N.push({ kind: 'ctx', oIdx: O.length - 1 });
    } else if (l[0] === '-') {
      O.push(l.slice(1));
    } else if (l[0] === '+') {
      N.push({ kind: 'add', text: l.slice(1) });
    }
    // a `\` line is a marker, not a content line
  }
  return { O, N };
}
/** Whether a `\` line follows the body's last context or `+` line (SPEC.md section 6). */
function backslashAfterLastCtxOrPlus(body: string[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') {
      return (body[k + 1] ?? '')[0] === '\\';
    }
  }
  return false;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Section 6: unified diffs ----------

/** The path after `--- ` or `+++ `, up to the first tab, surrounding spaces removed, a//b/ stripped, /dev/null as null. */
function dashPath(l: string): string | null {
  let s = l.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}
/** The paths of a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function diffGitPaths(l: string): [string, string] | null {
  if (!l.startsWith('diff --git a/')) return null;
  const rest = l.slice('diff --git a/'.length);
  const idx = rest.lastIndexOf(' b/');
  if (idx < 0) return null;
  const x = rest.slice(0, idx).trim();
  const y = rest.slice(idx + 3).trim();
  if (x === '' || y === '') return null;
  return [x, y];
}

interface UniHunk {
  a: number;
  body: string[];
}
interface UniSec {
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  diffOld: string | null | undefined;
  diffNew: string | null | undefined;
  create: boolean;
  del: boolean;
  hunks: UniHunk[];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const secs: UniSec[] = [];
  const hunkA = (l: string): number | null => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    return m ? parseInt(m[1]!, 10) : null;
  };
  const isBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
  const readBody = (start: number): { body: string[]; next: number } => {
    const body: string[] = [];
    let j = start;
    while (j < n) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (!isBodyLine(l)) break;
      body.push(l);
      j++;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return { body, next: j };
  };
  const newSec = (): UniSec => ({
    dashOld: undefined,
    dashNew: undefined,
    renOld: undefined,
    renNew: undefined,
    diffOld: undefined,
    diffNew: undefined,
    create: false,
    del: false,
    hunks: [],
  });
  let cur: UniSec | null = null;
  let state: 'out' | 'hdr' | 'between' = 'out';
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (state === 'out') {
      if (l.startsWith('diff --git ')) {
        const p = diffGitPaths(l);
        if (p === null) throw new Exit2(`error: parse ${i + 1}`);
        cur = newSec();
        cur.diffOld = p[0];
        cur.diffNew = p[1];
        secs.push(cur);
        state = 'hdr';
        i++;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSec();
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]!);
        secs.push(cur);
        state = 'hdr';
        i += 2;
      } else if (l.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
    } else if (state === 'hdr') {
      if (l.startsWith('@@')) {
        const a = hunkA(l);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        const { body, next } = readBody(i + 1);
        cur!.hunks.push({ a, body });
        i = next;
        state = 'between';
      } else if (l.startsWith('diff --git ')) {
        const p = diffGitPaths(l);
        if (p === null) throw new Exit2(`error: parse ${i + 1}`);
        cur = newSec();
        cur.diffOld = p[0];
        cur.diffNew = p[1];
        secs.push(cur);
        state = 'hdr';
        i++;
      } else if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur!.dashOld = dashPath(l);
        cur!.dashNew = dashPath(lines[i + 1]!);
        i += 2;
      } else if (l.startsWith('rename from ')) {
        cur!.renOld = l.slice('rename from '.length).trim();
        i++;
      } else if (l.startsWith('rename to ')) {
        cur!.renNew = l.slice('rename to '.length).trim();
        i++;
      } else if (l.startsWith('new file mode')) {
        cur!.create = true;
        i++;
      } else if (l.startsWith('deleted file mode')) {
        cur!.del = true;
        i++;
      } else {
        i++;
      }
    } else {
      if (l.startsWith('@@')) {
        const a = hunkA(l);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        const { body, next } = readBody(i + 1);
        cur!.hunks.push({ a, body });
        i = next;
      } else if (l.startsWith('diff --git ')) {
        const p = diffGitPaths(l);
        if (p === null) throw new Exit2(`error: parse ${i + 1}`);
        cur = newSec();
        cur.diffOld = p[0];
        cur.diffNew = p[1];
        secs.push(cur);
        state = 'hdr';
        i++;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSec();
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]!);
        secs.push(cur);
        state = 'hdr';
        i += 2;
      } else {
        i++;
      }
    }
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((sec) => uniSectionEdit(sec, strict));
}

/** Apply one section's hunks to a file's text, in order, tracking the delta (SPEC.md section 6). */
function applyUniHunks(text: string, hunks: UniHunk[], strict: boolean, path: string): string {
  let { br, lines, final } = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    const oLen = O.length;
    const nLen = N.length;
    if (oLen === 0) {
      const ins = Math.min(h.a + d, lines.length);
      const rep = buildN(lines, ins, O, N, 0);
      const atEnd = ins === lines.length;
      lines = [...lines.slice(0, ins), ...rep, ...lines.slice(ins)];
      if (atEnd) final = !backslashAfterLastCtxOrPlus(h.body);
      d += nLen;
      continue;
    }
    const tier = firstTier(lines, O, strict, 0);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrencesAt(lines, O, tier, 0);
    const target = h.a - 1 + d;
    let best = occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const rep = buildN(lines, best, O, N, tier);
    const touchedEnd = best + oLen === lines.length;
    lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + oLen)];
    if (touchedEnd) final = !backslashAfterLastCtxOrPlus(h.body);
    d += nLen - oLen;
  }
  return joinFile(br, lines, final);
}

function uniSectionEdit(sec: UniSec, strict: boolean): Edit {
  const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renOld !== undefined ? sec.renOld : sec.diffOld;
  const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renNew !== undefined ? sec.renNew : sec.diffNew;
  const isCreate = oldP === null || sec.create === true;
  const isDelete = newP === null || sec.del === true;
  return (tree) => {
    if (isCreate) {
      if (newP === null || newP === undefined) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let lastPlusBackslash = false;
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const l = h.body[k]!;
          if (l !== '' && l[0] === '+') {
            plus.push(l.slice(1));
            lastPlusBackslash = (h.body[k + 1] ?? '')[0] === '\\';
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null || oldP === undefined) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== undefined && newP !== undefined && oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUniHunks(before, sec.hunks, strict, oldP);
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null || p === undefined) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyUniHunks(before, sec.hunks, strict, p));
  };
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srBlockEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { br, lines, final } = splitFile(before);
    const tier = firstTier(lines, oldLines, strict, 0);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrencesAt(lines, oldLines, tier, 0);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const pos = occ[0]!;
    const items: NItem[] = newLines.map((t) => ({ kind: 'add' as const, text: t }));
    const rep = buildN(lines, pos, oldLines, items, tier);
    tree.now.set(path, joinFile(br, [...lines.slice(0, pos), ...rep, ...lines.slice(pos + oldLines.length)], final));
  };
}

// ---------- Section 8: V4A patches ----------

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let j = 0; j < n; j++) {
    if (!blank(lines[j]!)) {
      first = j;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  const isSecStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const secLines: string[] = [];
      let j = i + 1;
      while (j < last && !isSecStart(lines[j]!)) {
        secLines.push(lines[j]!);
        j++;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
      for (let k = 0; k < secLines.length; k++) {
        const m = secLines[k]!;
        if (m === '' || m[0] === '+') continue;
        throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      const fileLines = secLines.map((m) => (m === '' ? '' : m.slice(1)));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isSecStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const parsed = parseV4aUpdate(lines, i, last, isSecStart);
      edits.push(v4aUpdateEdit(path, parsed.moveTo, parsed.chunks, strict));
      i = parsed.next;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Parse an Update File section starting at 0-based `i`; returns the move target, the chunks and the next index. */
function parseV4aUpdate(
  lines: string[],
  i: number,
  last: number,
  isSecStart: (l: string) => boolean,
): { moveTo: string | null; chunks: V4aChunk[]; next: number } {
  let j = i + 1;
  let moveTo: string | null = null;
  // `*** Move to:` is the section's first line: the line right after `*** Update File: `.
  // A blank line there is a body line (an empty context line starting the first chunk), not a separator,
  // so blank lines are not skipped here.
  if (j < last && lines[j]!.startsWith('*** Move to: ')) {
    moveTo = lines[j]!.slice('*** Move to: '.length).trim();
    j++;
  }
  const chunks: V4aChunk[] = [];
  const isBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';
  while (j < last) {
    const l = lines[j]!;
    if (isSecStart(l)) break;
    if (l.trim() === '*** End Patch') break;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      const body: string[] = [];
      let eof = false;
      j++;
      while (j < last) {
        const m = lines[j]!;
        if (m.trim() === '*** End of File') {
          eof = true;
          j++;
          break;
        }
        if (m.startsWith('@@') || isSecStart(m)) break;
        if (!isBodyLine(m)) throw new Exit2(`error: parse ${j + 1}`);
        body.push(m);
        j++;
      }
      chunks.push({ anchor: anchor === '' ? null : anchor, body, eof });
      continue;
    }
    if (l.trim() === '*** End of File') {
      throw new Exit2(`error: parse ${j + 1}`);
    }
    if (!isBodyLine(l)) throw new Exit2(`error: parse ${j + 1}`);
    // first chunk starting at a body line
    const body: string[] = [];
    let eof = false;
    while (j < last) {
      const m = lines[j]!;
      if (m.trim() === '*** End of File') {
        eof = true;
        j++;
        break;
      }
      if (m.startsWith('@@') || isSecStart(m)) break;
      if (!isBodyLine(m)) throw new Exit2(`error: parse ${j + 1}`);
      body.push(m);
      j++;
    }
    chunks.push({ anchor: null, body, eof });
  }
  // Blank lines at the end of the section are not part of it: trim them from the last chunk.
  if (chunks.length > 0) {
    const lastChunk = chunks[chunks.length - 1]!;
    while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
  return { moveTo, chunks, next: j };
}

/** Find the first line at or after `from` equal to the single-line anchor at the first tier with one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (lineEqAt(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { br, lines, final } = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const ins = ch.eof ? lines.length : cursor;
        const rep = buildN(lines, ins, O, N, 0);
        lines = [...lines.slice(0, ins), ...rep, ...lines.slice(ins)];
        cursor = ins + rep.length;
        continue;
      }
      const tier = firstTier(lines, O, strict, cursor);
      if (tier < 0) throw new Fail('no-match', path);
      const occ = occurrencesAt(lines, O, tier, cursor);
      let pos = -1;
      if (ch.eof) {
        const want = lines.length - O.length;
        if (occ.includes(want)) pos = want;
      } else {
        pos = occ[0]!;
      }
      if (pos < 0) throw new Fail('no-match', path);
      const rep = buildN(lines, pos, O, N, tier);
      lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + O.length)];
      cursor = pos + rep.length;
    }
    const out = joinFile(br, lines, final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output: one line per changed path in byte order, R lines sorting by their new path (SPEC.md section 2).
  const paired = new Set<string>();
  const rows: { key: string; line: string; write: () => void }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      paired.add(oldP);
      paired.add(newP);
      rows.push({
        key: newP,
        line: `R ${oldP} -> ${newP}`,
        write: () => {
          rmSync(oldP, { force: true });
          mkdirSync(dirname(newP), { recursive: true });
          writeFileSync(newP, tree.get(newP)!);
        },
      });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({
      key: p,
      line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`,
      write: () => {
        if (now === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      },
    });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const r of rows) r.write();
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
