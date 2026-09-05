/* nasjidwg — full MTEXT inline-code parser.
 *
 * Parses the raw MTEXT byte stream into styled fragments (font, color,
 * height, underline/overline/strike, width, oblique, stacked fractions,
 * paragraphs). stripMtextCodes() remains the cheap plain-text path; this
 * parser is for renderers that want the formatting.
 */

export interface MTextStackedText {
  upper: string;
  lower: string;
  /** '/' horizontal bar, '#' diagonal, '^' tolerance (no bar). */
  divider: '/' | '#' | '^';
}

export interface MTextFragment {
  text: string;
  /** Font family from \f|\F (file or family name). */
  font?: string;
  bold?: boolean;
  italic?: boolean;
  /** Absolute height from \H<n>; */
  height?: number;
  /** Relative height factor from \H<n>x; */
  heightFactor?: number;
  /** ACI color from \C<n>; */
  colorAci?: number;
  /** True color from \c<n>; */
  colorRgb?: number;
  underline?: boolean;
  overline?: boolean;
  strike?: boolean;
  /** Width factor from \W<n>; */
  widthFactor?: number;
  /** Oblique angle in degrees from \Q<n>; */
  oblique?: number;
  /** Character tracking from \T<n>; */
  tracking?: number;
  /** Paragraph vertical alignment from \A<n>; (0 bottom, 1 center, 2 top). */
  alignment?: number;
  /** This fragment starts a new paragraph (was preceded by \P). */
  newParagraph?: boolean;
  /** Stacked fraction from \S...;. `text` is empty on such fragments. */
  stacked?: MTextStackedText;
}

interface Style {
  font?: string; bold?: boolean; italic?: boolean;
  height?: number; heightFactor?: number;
  colorAci?: number; colorRgb?: number;
  underline?: boolean; overline?: boolean; strike?: boolean;
  widthFactor?: number; oblique?: number; tracking?: number;
  alignment?: number;
}

/** Parse raw MTEXT contents into ordered styled fragments. */
export const parseMtext = (raw: string): MTextFragment[] => {
  const src = String(raw ?? '');
  const frags: MTextFragment[] = [];
  let style: Style = {};
  const stack: Style[] = [];
  let buf = '';
  let paragraph = false;

  const flush = (): void => {
    if (!buf) return;
    frags.push({ text: buf, ...style, ...(paragraph ? { newParagraph: true } : {}) });
    buf = '';
    paragraph = false;
  };
  const pushFrag = (f: MTextFragment): void => {
    flush();
    frags.push({ ...style, ...f, ...(paragraph ? { newParagraph: true } : {}) });
    paragraph = false;
  };

  /* read a \X...; argument */
  const arg = (from: number): [string, number] => {
    let end = src.indexOf(';', from);
    if (end === -1) end = src.length;
    return [src.slice(from, end), Math.min(end + 1, src.length)];
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') { stack.push({ ...style }); i++; continue; }
    if (ch === '}') { flush(); style = stack.pop() ?? {}; i++; continue; }
    if (ch !== '\\') { buf += ch; i++; continue; }

    const code = src[i + 1];
    if (code === undefined) { i++; continue; }
    switch (code) {
      case '\\': case '{': case '}':
        buf += code; i += 2; break;
      case 'P':
        flush(); paragraph = true; i += 2; break;
      case '~': buf += ' '; i += 2; break;
      case 'L': flush(); style.underline = true; i += 2; break;
      case 'l': flush(); style.underline = false; i += 2; break;
      case 'O': flush(); style.overline = true; i += 2; break;
      case 'o': flush(); style.overline = false; i += 2; break;
      case 'K': flush(); style.strike = true; i += 2; break;
      case 'k': flush(); style.strike = false; i += 2; break;
      case 'A': {
        const [v, next] = arg(i + 2);
        flush();
        const n = parseInt(v, 10);
        if (n >= 0 && n <= 2) style.alignment = n;
        i = next; break;
      }
      case 'C': {
        const [v, next] = arg(i + 2);
        flush();
        const n = parseInt(v, 10);
        if (isFinite(n)) { style.colorAci = n; delete style.colorRgb; }
        i = next; break;
      }
      case 'c': {
        const [v, next] = arg(i + 2);
        flush();
        const n = parseInt(v, 10);
        if (isFinite(n)) {
          /* stored as BGR — expose as 0xRRGGBB */
          style.colorRgb = ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff);
          delete style.colorAci;
        }
        i = next; break;
      }
      case 'f': case 'F': {
        const [v, next] = arg(i + 2);
        flush();
        /* \fArial|b1|i0|c0|p34; — family, bold, italic flags */
        const parts = v.split('|');
        style.font = parts[0] || undefined;
        for (const p of parts.slice(1)) {
          if (/^b1$/i.test(p)) style.bold = true;
          else if (/^b0$/i.test(p)) style.bold = false;
          else if (/^i1$/i.test(p)) style.italic = true;
          else if (/^i0$/i.test(p)) style.italic = false;
        }
        i = next; break;
      }
      case 'H': {
        const [v, next] = arg(i + 2);
        flush();
        if (/x$/i.test(v)) {
          const n = parseFloat(v.slice(0, -1));
          if (isFinite(n) && n > 0) { style.heightFactor = n; delete style.height; }
        } else {
          const n = parseFloat(v);
          if (isFinite(n) && n > 0) { style.height = n; delete style.heightFactor; }
        }
        i = next; break;
      }
      case 'W': {
        const [v, next] = arg(i + 2);
        flush();
        const n = parseFloat(v);
        if (isFinite(n) && n > 0) style.widthFactor = n;
        i = next; break;
      }
      case 'Q': {
        const [v, next] = arg(i + 2);
        flush();
        const n = parseFloat(v);
        if (isFinite(n)) style.oblique = n;
        i = next; break;
      }
      case 'T': {
        const [v, next] = arg(i + 2);
        flush();
        const n = parseFloat(v);
        if (isFinite(n)) style.tracking = n;
        i = next; break;
      }
      case 'S': {
        const [v, next] = arg(i + 2);
        const m = v.match(/^(.*?)([/#^])(.*)$/s);
        if (m) {
          pushFrag({
            text: '',
            stacked: {
              upper: m[1], lower: m[3].replace(/^ /, ''),
              divider: m[2] as MTextStackedText['divider']
            }
          });
        } else buf += v;
        i = next; break;
      }
      case 'U': case 'u': {
        /* \U+XXXX unicode escape */
        const m = src.slice(i).match(/^\\[Uu]\+([0-9A-Fa-f]{4})/);
        if (m) { buf += String.fromCharCode(parseInt(m[1], 16)); i += m[0].length; }
        else { buf += code; i += 2; }
        break;
      }
      default: {
        /* unknown control: skip its argument when it has one */
        if ('ACcfFHWQTS'.includes(code)) { const [, next] = arg(i + 2); i = next; }
        else { buf += code; i += 2; }
        break;
      }
    }
  }
  flush();
  return frags;
};

/** Plain text of parsed fragments (paragraphs as \n, fractions as a/b). */
export const mtextPlainText = (frags: readonly MTextFragment[]): string =>
  frags.map((f) =>
    (f.newParagraph ? '\n' : '') +
    (f.stacked ? f.stacked.upper + '/' + f.stacked.lower : f.text)
  ).join('');

/** The paragraph codes (`\p…;`) an older release can show.
 *
 *  The 2008 release of the reference added paragraph alignment, spacing
 *  before/after and typed tab stops, spelled `\px…;` with every distance
 *  in multiples of the text height; the 2004 release knew indents and
 *  plain tab stops (`\pi`, `\pl`, `\pr`, `\pt`) in drawing units; 2000
 *  and R14 knew no paragraph codes at all. Saved into an older release,
 *  the reference rewrites the text the way that release can show it
 *  (and keeps the original under an ACAD_MTEXT_2008_RT xrecord in the
 *  entity's extension dictionary). Measured on its own saves of a text
 *  spelled `\pxqc;…\P\pxi-3,l3,t3;…` at height 2.5: the 2004 file
 *  carries `\pi…,l7.5,t…;` — the distances scaled by the height, the
 *  alignment and spacing gone (emulated by indents the reference
 *  computes from the glyph widths, which is not attempted here) — and
 *  a text without any `\px` keeps its 2004 codes untouched; the 2000
 *  and R14 files carry no `\p…;` code at all (tabs emulated by widened
 *  spaces there, again not attempted). `release` is the target
 *  (13, 14, 2000, 2004, …); 2007 and later return the text as is. */
export const flattenMtextParagraphs = (
  text: string, release: number, height: number
): string => {
  if (release >= 2007) return text;
  const BSL = String.fromCharCode(1);      /* placeholder for escaped \\ */
  const s = String(text).replace(/\\\\/g, BSL);
  const restore = (v: string): string => v.replace(new RegExp(BSL, 'g'), '\\\\');
  if (release <= 2000) return restore(s.replace(/\\p[^;]*;/g, ''));
  if (!/\\px/.test(s)) return text;
  const unit = Number.isFinite(height) && height > 0 ? height : 1;
  const num = /^-?(\d+\.?\d*|\.\d+)$/;
  const scaled = (v: string): string => String(+(Number(v) * unit).toFixed(5));
  return restore(s.replace(/\\p([^;]*);/g, (_m, body: string) => {
    const kept: string[] = [];
    const tabs: string[] = [];
    let inTabs = false;
    for (const prop of body.replace(/^x/, '').split(',')) {
      if (inTabs) {
        /* a typed stop (c/r/d prefix) is a 2008 spelling: dropped */
        if (num.test(prop)) tabs.push(scaled(prop));
        continue;
      }
      const key = prop[0], value = prop.slice(1);
      if ((key === 'i' || key === 'l' || key === 'r') && num.test(value)) {
        kept.push(key + scaled(value));
      } else if (key === 't') {
        inTabs = true;
        if (num.test(value)) tabs.push(scaled(value));
      }
      /* q (alignment), b/a (spacing) and anything else: 2008 only */
    }
    if (tabs.length) kept.push('t' + tabs.join(','));
    return kept.length ? '\\p' + kept.join(',') + ';' : '';
  }));
};
