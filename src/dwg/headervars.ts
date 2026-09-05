/* nasjidwg — header variables section reader (R13-R2018).
 *
 * One long fixed sequence of bitcode fields; R2007+ splits handles and
 * strings into their own streams inside the section (same discipline as
 * objects). Parsing is tolerant: everything decoded before a failure is
 * kept, and the caller merges what it needs into the document header.
 */

import { BitReader, decodeCodepage } from './bitstream.js';
import { versionRank } from './fileheader.js';
import type { FileVersion, HeaderUcs, Point2, Point3 } from '../core/model.js';

export interface HeaderVars {
  insUnits?: number;
  extMin?: Point3;
  extMax?: Point3;
  limMin?: Point2;
  limMax?: Point2;
  ltScale?: number;
  textSize?: number;
  pdMode?: number;
  pdSize?: number;
  clayerHandle?: number;
  textStyleHandle?: number;
  celtypeHandle?: number;
  dimStyleHandle?: number;
  /** CMLSTYLE: the current multiline style's record. */
  cmlStyleHandle?: number;
  /** UCSNAME / PUCSNAME: the named UCS records the current model and
   *  paper coordinate systems are, when they are named ones. */
  ucsNameHandle?: number;
  pUcsNameHandle?: number;
  /** The named objects dictionary's handle: the root the reader walks
   *  to tell the dictionary tree from the extension dictionaries. */
  nodHandle?: number;
  handseed?: number;
  celColorIndex?: number;
  /** UCSORG/UCSXDIR/UCSYDIR: the current coordinate system. A drawing laid
   *  out at an angle carries the rotation here, so dropping it draws the
   *  model turned. */
  ucs?: HeaderUcs;
  /** The paper-space twin (PUCSORG/PUCSXDIR/PUCSYDIR). */
  pUcs?: HeaderUcs;
  measurementMetricUnits?: boolean;
  /** Assorted named scalars, for callers that want more. */
  vars: Record<string, number | string | boolean>;
}

const SENTINEL_FIRST = 0xCF;

export const readHeaderVars = (
  section: Uint8Array, version: FileVersion, maint: number, codepage?: string
): HeaderVars | null => {
  /* R13 may or may not carry SAVEIMAGES (release-dependent); try both. */
  const a = readHeaderVarsWith(section, version, maint, codepage, false);
  const sane = (h: HeaderVars | null): boolean =>
    !!h?.extMin && Math.abs(h.extMin.x) < 1e19 && isFinite(h.extMin.x);
  if (sane(a) || versionRank(version) !== 13) return a;
  const b = readHeaderVarsWith(section, version, maint, codepage, true);
  return sane(b) ? b : a;
};

const readHeaderVarsWith = (
  section: Uint8Array, version: FileVersion, maint: number,
  codepage: string | undefined, r13SaveImages: boolean
): HeaderVars | null => {
  const v = versionRank(version);
  const out: HeaderVars = { vars: {} };
  try {
    let p = 0;
    if (section[0] === SENTINEL_FIRST) p = 16;
    const dv = new DataView(section.buffer, section.byteOffset, section.byteLength);
    dv.getUint32(p, true);                /* RL size (unused) */
    p += 4;

    let r: BitReader;
    let hr: BitReader;
    let sr: BitReader | null = null;
    if (v >= 2007) {
      let headerBits = 160;               /* sentinel + size */
      /* R2010+ may add a high-dword size field; R2007 never has it */
      if (v >= 2010 && (v >= 2018 || maint > 3)) { p += 4; headerBits += 32; }
      const bitsizeFieldBit = p * 8;
      const bitsize = dv.getUint32(p, true);
      p += 4;
      r = new BitReader(section, p * 8);
      hr = new BitReader(section, headerBits + bitsize);
      /* string stream: endbit flag at bitsizeFieldStart + bitsize - 1 */
      const endBit = bitsizeFieldBit + bitsize - 1;
      const probe = new BitReader(section, endBit);
      if (probe.b()) {
        let pos = endBit - 16;
        probe.pos = pos;
        let strSize = probe.rs();
        if (strSize & 0x8000) {
          pos -= 16;
          probe.pos = pos;
          const hi = probe.rs();
          strSize = (strSize & 0x7fff) | (hi << 15);
        }
        sr = new BitReader(section, pos - strSize, endBit);
      }
    } else {
      r = new BitReader(section, p * 8);
      hr = r;                             /* one shared stream */
    }

    const text = (): string =>
      sr ? sr.tu() : decodeCodepage(r.tBytes(), codepage);
    const H = (): number => hr.h().value;
    const cmc = (): number => {
      const index = r.bs();
      if (v < 2004) return index;
      /* R2004+ carries the colour in the BL with an AcCmEntityColor method
         byte on top: C0 ByLayer, C1 ByBlock, C2 true RGB, C3 ACI. AutoCAD
         leaves the BS index at 0 and speaks only through the method. */
      const rgb = r.bl() >>> 0;
      const byte = r.rc();
      if (byte & 1) text();
      if (byte & 2) text();
      const method = (rgb >>> 24) & 0xff;
      if (method === 0xc0) return 256;    /* ByLayer */
      if (method === 0xc1) return 0;      /* ByBlock */
      if (method === 0xc3) return rgb & 0xff;
      return index;
    };
    /** A date field: the Julian day and the milliseconds into it, kept as
     *  the two raw halves — the day number alone floors to midnight, and
     *  the millisecond half is what tells two saves of one drawing apart. */
    const timebll = (name: string): void => {
      out.vars[name] = r.bl();
      out.vars[name + '_MS'] = r.bl();
    };
    const p3 = (): Point3 => { const [x, y, z] = r.bd3(); return { x, y, z }; };
    const p2 = (): Point2 => ({ x: r.rd(), y: r.rd() });

    if (v >= 2013) r.bll();               /* REQUIREDVERSIONS */
    r.bd(); r.bd(); r.bd(); r.bd();       /* unit ratios */
    /* the four unit names exist in every release: inline text through
       R2004, entries in the string stream from R2007 on */
    text(); text(); text(); text();

    r.bl(); r.bl();                       /* unknown 8, 9 */
    if (v <= 14) r.bs();                  /* unknown 10 */
    if (v <= 2000) H();                   /* VX record */
    r.b(); r.b();                         /* DIMASO, DIMSHO */
    if (v <= 14) r.b();                   /* DIMSAV */
    r.b(); r.b(); r.b(); r.b(); r.b(); r.b(); r.b();   /* PLINEGEN..LIMCHECK */
    if (v <= 14) r.b();                   /* BLIPMODE */
    if (v >= 2004) r.b();                 /* unknown 11 */
    r.b(); r.b(); r.b(); r.b();           /* USRTIMER..SPLFRAME */
    if (v <= 14) { r.b(); r.b(); }        /* ATTREQ, ATTDIA */
    r.b(); r.b();                         /* MIRRTEXT, WORLDVIEW */
    if (v <= 14) r.b();                   /* WIREFRAME */
    const tilemode = r.b();
    out.vars.TILEMODE = tilemode === 1;
    r.b(); r.b();                         /* PLIMCHECK, VISRETAIN */
    if (v <= 14) r.b();                   /* DELOBJ */
    r.b(); r.b();                         /* DISPSILH, PELLIPSE */
    if (v === 13 && r13SaveImages) r.bs();  /* SAVEIMAGES (some R13 builds) */
    r.bs();                               /* PROXYGRAPHICS */
    if (v <= 14) r.bs();                  /* DRAGMODE */
    r.bs();                               /* TREEDEPTH */
    out.vars.LUNITS = r.bs();
    out.vars.LUPREC = r.bs();
    out.vars.AUNITS = r.bs();
    out.vars.AUPREC = r.bs();
    if (v <= 14) r.bs();                  /* OSMODE */
    r.bs();                               /* ATTMODE */
    if (v <= 14) r.bs();                  /* COORDS */
    out.pdMode = r.bs();
    if (v <= 14) r.bs();                  /* PICKSTYLE */
    if (v >= 2004) { r.bl(); r.bl(); r.bl(); }
    for (let i = 0; i < 5; i++) r.bs();   /* USERI */
    /* SPLINESEGS..TEXTQLTY. The twelfth is ISOLINES: how many
       tessellation lines a curved face of a solid is drawn across, which
       is most of what a wireframe view of a tube consists of. */
    for (let i = 0; i < 14; i++) {
      const val = r.bs();
      if (i === 11) out.vars.ISOLINES = val;
    }
    out.ltScale = r.bd();
    out.textSize = r.bd();
    r.bd(); r.bd(); r.bd(); r.bd();       /* TRACEWID..THICKNESS */
    out.vars.ANGBASE = r.bd();
    out.pdSize = r.bd();
    r.bd();                               /* PLINEWID */
    for (let i = 0; i < 5; i++) r.bd();   /* USERR */
    for (let i = 0; i < 4; i++) r.bd();   /* CHAMFER */
    r.bd(); r.bd(); r.bd();               /* FACETRES, CMLSCALE, CELTSCALE */
    text();                               /* MENU (string stream in R2007+) */
    timebll('TDCREATE');                  /* TDUCREATE days + ms */
    timebll('TDUPDATE');
    if (v >= 2004) { r.bl(); r.bl(); r.bl(); }
    timebll('TDINDWG'); timebll('TDUSRTIMER');
    out.celColorIndex = cmc();            /* CECOLOR */
    out.handseed = r.h().value;           /* HANDSEED lives in the data stream */
    out.clayerHandle = H();
    out.textStyleHandle = H();
    out.celtypeHandle = H();
    if (v >= 2007) H();                   /* CMATERIAL */
    out.dimStyleHandle = H();
    out.cmlStyleHandle = H() || undefined;   /* CMLSTYLE */
    if (v >= 2000) r.bd();                /* PSVPSCALE */
    /* paper space block */
    p3();                                 /* PINSBASE */
    p3(); p3();                           /* PEXTMIN/MAX */
    p2(); p2();                           /* PLIMMIN/MAX */
    r.bd();                               /* PELEVATION */
    out.pUcs = { origin: p3(), xAxis: p3(), yAxis: p3() };
    out.pUcsNameHandle = H() || undefined;   /* PUCSNAME */
    if (v >= 2000) {
      H(); r.bs(); H();                   /* PUCSORTHOREF/VIEW/BASE */
      for (let i = 0; i < 6; i++) p3();
    }
    /* model space block */
    p3();                                 /* INSBASE */
    out.extMin = p3();
    out.extMax = p3();
    out.limMin = p2();
    out.limMax = p2();
    r.bd();                               /* ELEVATION */
    out.ucs = { origin: p3(), xAxis: p3(), yAxis: p3() };
    out.ucsNameHandle = H() || undefined;    /* UCSNAME */
    if (v >= 2000) {
      H(); r.bs(); H();
      for (let i = 0; i < 6; i++) p3();
      text(); text();                     /* DIMPOST, DIMAPOST (pre-2007 inline) */
    }
    if (v <= 14) {
      /* R13/14 dimension flag block */
      for (let i = 0; i < 11; i++) r.b();
      r.rc(); r.rc();
      r.b(); r.b();
      r.rc(); r.rc(); r.rc();
      r.b();
      r.rc(); r.rc(); r.rc(); r.rc();
      r.bs(); r.bs(); r.bs(); r.bs(); r.bs(); r.bs();
      H();                                /* DIMTXSTY */
    }
    /* the current dimensioning sizes — what explodeDimension and every
       dimension-drawing consumer needs. The positions have long been
       proven (everything after them decodes correctly); the values were
       merely read and discarded before. */
    for (const k of ['DIMSCALE', 'DIMASZ', 'DIMEXO', 'DIMDLI', 'DIMEXE',
      'DIMRND', 'DIMDLE', 'DIMTP', 'DIMTM']) out.vars[k] = r.bd();
    if (v >= 2007) { r.bd(); r.bd(); r.bs(); cmc(); }
    if (v >= 2000) {
      for (let i = 0; i < 6; i++) r.b();  /* DIMTOL..DIMSE2 */
      r.bs(); r.bs(); r.bs();             /* DIMTAD, DIMZIN, DIMAZIN */
    }
    if (v >= 2007) r.bs();                /* DIMARCSYM */
    for (const k of ['DIMTXT', 'DIMCEN', 'DIMTSZ', 'DIMALTF', 'DIMLFAC',
      'DIMTVP', 'DIMTFAC', 'DIMGAP']) out.vars[k] = r.bd();
    if (v <= 14) { text(); text(); text(); text(); text(); }
    if (v >= 2000) {
      r.bd(); r.b(); r.bs();              /* DIMALTRND, DIMALT, DIMALTD */
      r.b(); r.b(); r.b(); r.b();         /* DIMTOFL..DIMSOXD */
    }
    cmc(); cmc(); cmc();                  /* DIMCLRD/E/T */
    if (v >= 2000) {
      r.bs();                             /* DIMADEC */
      out.vars.DIMDEC = r.bs();
      for (let i = 0; i < 9; i++) r.bs(); /* DIMTDEC..DIMJUST */
      r.b(); r.b();                       /* DIMSD1/2 */
      r.bs(); r.bs(); r.bs(); r.bs();     /* DIMTOLJ..DIMALTTZ */
      r.b(); r.bs();                      /* DIMUPT, DIMATFIT */
    }
    if (v >= 2007) r.b();                 /* DIMFXLON */
    if (v >= 2010) {
      r.b();                              /* DIMTXTDIRECTION */
      r.bd(); text();                     /* DIMALTMZF, DIMALTMZS */
      r.bd(); text();                     /* DIMMZF, DIMMZS */
    }
    if (v >= 2000) {
      for (let i = 0; i < 5; i++) H();    /* DIMTXSTY..DIMBLK2 */
      if (v >= 2007) { H(); H(); H(); }   /* DIMLTYPE, DIMLTEX1/2 */
      r.bs(); r.bs();                     /* DIMLWD, DIMLWE */
    }
    for (let i = 0; i < 9; i++) H();      /* control objects */
    if (v <= 2000) H();                   /* VX control */
    H(); H();                             /* group/mlinestyle dicts */
    out.nodHandle = H() || undefined;     /* the named objects dictionary */
    if (v >= 2000) {
      r.bs(); r.bs();                     /* TSTACKALIGN/SIZE */
      if (v < 2007) { text(); text(); }   /* HYPERLINKBASE, STYLESHEET */
      else { text(); text(); }            /* same slots from the string stream */
      H(); H(); H();                      /* layout/plotsettings/plotstyle dicts */
      if (v >= 2004) { H(); H(); }        /* material, color dicts */
      if (v >= 2007) H();                 /* visualstyle dict */
      if (v >= 2013) H();                 /* lightlist dict */
      r.bl();                             /* FLAGS */
      out.insUnits = r.bs();
      const cepsntype = r.bs();
      if (cepsntype === 3) H();
      out.vars.FINGERPRINTGUID = text();
      out.vars.VERSIONGUID = text();
    }
    if (v >= 2004) {
      out.vars.SORTENTS = r.rc();
      out.vars.INDEXCTL = r.rc();
      out.vars.HIDETEXT = r.rc();
      out.vars.XCLIPFRAME = r.rc();
      out.vars.DIMASSOC = r.rc();
      out.vars.HALOGAP = r.rc();
      r.bs(); r.bs();                     /* OBSCUREDCOLOR, INTERSECTIONCOLOR */
      r.rc(); r.rc();                     /* OBSCUREDLTYPE, INTERSECTIONDISPLAY */
      text();                             /* PROJECTNAME */
    }
    /* trailing block records and the three built-in linetypes */
    H(); H();                             /* *PAPER_SPACE, *MODEL_SPACE */
    H(); H(); H();                        /* BYLAYER, BYBLOCK, CONTINUOUS */
    if (v >= 2007) {
      /* the R2007+ camera / solids / geolocation block */
      out.vars.CAMERADISPLAY = r.b() === 1;
      r.bl(); r.bl(); r.bd();             /* unknowns 21-23 */
      out.vars.STEPSPERSEC = r.bd();
      out.vars.STEPSIZE = r.bd();
      out.vars['3DDWFPREC'] = r.bd();
      out.vars.LENSLENGTH = r.bd();
      out.vars.CAMERAHEIGHT = r.bd();
      out.vars.SOLIDHIST = r.rc();
      out.vars.SHOWHIST = r.rc();
      out.vars.PSOLWIDTH = r.bd();
      out.vars.PSOLHEIGHT = r.bd();
      out.vars.LOFTANG1 = r.bd();
      out.vars.LOFTANG2 = r.bd();
      out.vars.LOFTMAG1 = r.bd();
      out.vars.LOFTMAG2 = r.bd();
      out.vars.LOFTPARAM = r.bs();
      out.vars.LOFTNORMALS = r.rc();
      out.vars.LATITUDE = r.bd();
      out.vars.LONGITUDE = r.bd();
      out.vars.NORTHDIRECTION = r.bd();
      out.vars.TIMEZONE = r.bl();
      out.vars.LIGHTGLYPHDISPLAY = r.rc();
      out.vars.TILEMODELIGHTSYNCH = r.rc();
      out.vars.DWFFRAME = r.rc();
      out.vars.DGNFRAME = r.rc();
      r.b();                              /* unknown 47 */
      out.vars.INTERFERECOLOR = cmc();
      H(); H(); H();                      /* INTERFEREOBJVS/VPVS, DRAGVS */
      out.vars.CSHADOW = r.rc();
      r.bd();                             /* unknown 53 */
    }
    /* four unknown shorts close the data: R13 through R2004 — R2007+
       dropped them. Vintage AC1012 files carry them as BS(-1). */
    if (v >= 13 && v <= 2004) { r.bs(); r.bs(); r.bs(); r.bs(); }
  } catch {
    /* keep whatever parsed */
  }
  return (out.extMin || out.insUnits !== undefined || out.ltScale !== undefined)
    ? out : null;
};
