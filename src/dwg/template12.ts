/* nasjidwg — AC1009 (R12) writer templates.
 *
 * An R12 file opens with a fixed-layout block: a short signature and
 * locator table, then the drawing-variables run, with five of the ten
 * table directories embedded at fixed offsets inside that run. The block
 * is a constant size, so the writer's job is to lay this default block
 * down and patch the drawing's own values over it.
 *
 * The block is built here field by field. Every offset is the one
 * src/dwg/pre13.ts arrives at reading the same sequence back — that
 * reader is the specification this writer is held to, and the two are
 * checked against each other on every test run. Every value is either
 * AutoCAD's factory default for a new drawing or a zero; nothing here
 * describes any particular drawing. Anything the writer computes for
 * itself (section addresses, table directories, extents, view, current
 * layer and style) is left at zero and filled in at write time.
 */

const HEADER_SIZE = 0x6bd;
const VPORT_SIZE = 251;

type Field =
  | [at: number, kind: 'u8' | 'u16' | 'u32', value: number]
  | [at: number, kind: 'f64', value: number]
  | [at: number, kind: 'ascii', value: string]
  | [at: number, kind: 'hex', value: string];

const lay = (size: number, fields: readonly Field[]): Uint8Array => {
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  for (const [at, kind, value] of fields) {
    switch (kind) {
      case 'u8': buf[at] = value as number; break;
      case 'u16': dv.setUint16(at, value as number, true); break;
      case 'u32': dv.setUint32(at, value as number, true); break;
      case 'f64': dv.setFloat64(at, value as number, true); break;
      case 'ascii':
        for (let i = 0; i < (value as string).length; i++) {
          buf[at + i] = (value as string).charCodeAt(i);
        }
        break;
      case 'hex':
        for (let i = 0; i < (value as string).length; i += 2) {
          buf[at + i / 2] = parseInt((value as string).substr(i, 2), 16);
        }
        break;
    }
  }
  return buf;
};

/* The drawing variables, in the order pre13.ts reads them. Offsets not
 * listed are zero — which is the right default for every point, angle,
 * mode flag and tolerance the format defines. */
const HEADER_FIELDS: readonly Field[] = [
  [0x000, 'ascii', 'AC1009'],           /* release signature */
  [0x00c, 'u8', 1],                     /* header layout discriminator */
  [0x00d, 'u16', 3],                    /* entity runs: model, blocks, extras */
  [0x00f, 'u16', 5],                    /* table directories in the leading run */
  [0x011, 'u16', 205],                  /* drawing variables that follow */
  /* 0x014..0x05d — section addresses and the BLOCK/LAYER/STYLE/LTYPE/VIEW
     directories. Computed per file; the writer fills them. */
  /* 0x05e INSBASE, 0x078 EXTMIN, 0x090 EXTMAX, 0x0a8 LIMMIN, 0x0b8 LIMMAX,
     0x0c8 VIEWCTR, 0x0e0 VIEWSIZE — all taken from the drawing. */
  [0x0ea, 'f64', 1],                    /* SNAPUNIT x */
  [0x0f2, 'f64', 1],                    /* SNAPUNIT y */
  [0x12a, 'u16', 1],                    /* REGENMODE on */
  [0x12c, 'u16', 1],                    /* FILLMODE on */
  [0x130, 'u16', 2],                    /* DRAGMODE auto */
  [0x132, 'f64', 1],                    /* LTSCALE */
  [0x13a, 'f64', 0.2],                  /* TEXTSIZE */
  [0x142, 'f64', 0.2],                  /* TRACEWID */
  [0x14c, 'u32', 15],                   /* entity colour carried from R9 files */
  /* 0x15c — viewport aspect ratio; derived from the view, so left at zero */
  [0x164, 'u16', 2],                    /* LUNITS decimal */
  [0x166, 'u16', 4],                    /* LUPREC 4 places */
  [0x17a, 'f64', 0.1],                  /* SKETCHINC */
  [0x192, 'u16', 1],                    /* ATTMODE normal */
  [0x194, 'ascii', 'acad'],             /* MENU, 15 bytes */
  [0x1a3, 'f64', 1],                    /* DIMSCALE */
  [0x1ab, 'f64', 0.18],                 /* DIMASZ */
  [0x1b3, 'f64', 0.0625],               /* DIMEXO */
  [0x1bb, 'f64', 0.38],                 /* DIMDLI */
  [0x1c3, 'f64', 0.18],                 /* DIMEXE */
  [0x1db, 'f64', 0.18],                 /* DIMTXT */
  [0x1e3, 'f64', 0.09],                 /* DIMCEN */
  [0x1f5, 'u8', 1],                     /* DIMTIH */
  [0x1f6, 'u8', 1],                     /* DIMTOH */
  [0x249, 'f64', 1],                    /* VIEWDIR z — looking down +Z */
  [0x2e3, 'u16', 1],                    /* BLIPMODE */

  /* The R11/R12 additions fill the rest of the block: the paper-space
   * mirror of the model-space variables, the UCS vectors, and the second
   * half of the dimension settings. They are grouped here as they sit in
   * the block, all at their factory values. */
  [0x317, 'u8', 100],                   /* MAXACTVP */
  [0x31c, 'hex', '01ff7f'],             /* handle mode on, handle seed ceiling */
  /* 0x31f..0x33b — TDCREATE/TDUPDATE/TDINDWG/TDUSRTIMER. A new file has no
     history, so the clocks start at zero. */
  [0x33c, 'hex', '220000010001'],       /* USRTIMER, ANGDIR, PDMODE group */
  [0x3a2, 'hex', '020101'],             /* DIMALTD, DIMTOFL, DIMSAH */
  [0x3c5, 'f64', 25.4],                 /* DIMALTF */
  [0x3cd, 'f64', 1],                    /* DIMLFAC */
  [0x3d5, 'u16', 8],                    /* SPLINESEGS */
  [0x3d9, 'u8', 1],                     /* SPLFRAME group */
  [0x3ed, 'u16', 1],                    /* UCSICON */
  /* 0x3ef — UCS directory, written per file */
  [0x3f5, 'hex', '100f'],               /* PICKSTYLE / OSMODE defaults */
  [0x413, 'f64', 1],                    /* UCSXDIR x */
  [0x433, 'f64', 1],                    /* UCSYDIR y */
  [0x45b, 'f64', 50],                   /* CHAMFERC / VIEWTWIST group */
  [0x4f6, 'hex', '06000600060006000600fd000200'],
                                        /* SURFTAB1/2, SURFTYPE, SURFU/V,
                                           SPLINETYPE, then MEASUREMENT */
  /* 0x500 — VPORT directory, written per file */
  [0x50c, 'hex', '06000100'],           /* SHADEDGE, SHADEDIF */
  /* 0x512 — APPID directory, 0x522 — DIMSTYLE directory, written per file */
  [0x537, 'hex', '030046'],             /* PLINETYPE, PSTYLEMODE group */
  [0x54d, 'f64', 1],                    /* PUCSXDIR x */
  [0x555, 'f64', 1],                    /* PUCSYDIR y */
  [0x55d, 'f64', 1],                    /* PSVPSCALE */
  [0x5e5, 'f64', 1],                    /* paper-space UCS x */
  [0x605, 'f64', 1],                    /* paper-space UCS y */
  [0x625, 'f64', 1],                    /* paper-space UCS z */
  [0x62f, 'hex', 'ffff01'],             /* paper-space flags */
  /* PEXTMIN / PEXTMAX: the "no extents yet" markers a fresh layout carries */
  [0x637, 'f64', 1e20], [0x63f, 'f64', 1e20], [0x647, 'f64', 1e20],
  [0x64f, 'f64', -1e20], [0x657, 'f64', -1e20], [0x65f, 'f64', -1e20],
  [0x677, 'f64', 12],                   /* PLIMMAX x */
  [0x67f, 'f64', 9],                    /* PLIMMAX y */
  /* 0x69f — VX directory, written per file */
  [0x6b5, 'f64', 0.09],                 /* DIMCEN, paper-space copy */
];

/** The fixed-size block every AC1009 file opens with: signature, section
 *  locators and the drawing-variables run, with the UCS/VPORT/APPID/
 *  DIMSTYLE/VX table directories embedded at fixed offsets inside it.
 *  Bytes [0, 0x6BD); a CRC16 and the entities sentinel follow it, so the
 *  first entity always starts at 0x6CF. */
export const HEADER_TEMPLATE: Uint8Array = lay(HEADER_SIZE, HEADER_FIELDS);

/** One '*ACTIVE' VPORT record at its defaults (251 bytes, CRC excluded).
 *  The writer overwrites the view height and centre. */
export const VPORT_TEMPLATE: Uint8Array = lay(VPORT_SIZE, [
  [0x00, 'u8', 0x80],                   /* record flags */
  [0x01, 'ascii', '*ACTIVE'],           /* name, 32 bytes */
  [0x21, 'u16', 0xffff],                /* use count: unlimited */
  [0x33, 'f64', 1],                     /* upper-right corner x */
  [0x3b, 'f64', 1],                     /* upper-right corner y */
  [0x6b, 'f64', 1],                     /* view direction z */
  /* 0x7b view height, 0x83/0x8b view centre — set from the drawing */
  /* 0x93 aspect ratio — derived, left at zero */
  [0x9b, 'f64', 50],                    /* lens length */
  [0xb5, 'u16', 100],                   /* circle zoom percent */
  [0xb7, 'u16', 1],                     /* fast zoom */
  [0xb9, 'u16', 1],                     /* UCS icon */
  [0xdb, 'f64', 1],                     /* snap spacing x */
  [0xe3, 'f64', 1],                     /* snap spacing y */
]);

/** Section begin sentinels. These sixteen-byte markers are the same in
 *  every AC1009 file ever written — they are how a reader finds a section
 *  when the locator table is damaged. Each section's end sentinel is the
 *  bitwise complement of its begin sentinel. */
export const SENTINELS = {
  entities: 'c46e6854f86e3330633ec1852adc9401',
  BLOCK: 'dbefb3f0c73e6da6c9b6245c4c6f32cb',
  LAYER: '0ec4646fbb1dd38b0049c2ef18ea6ffb',
  STYLE: 'e23ec182439f617750abc76696000618',
  LTYPE: 'ac901aca1cbd951516164c14ce1888af',
  VIEW: 'c13caa5668f4b41e4b74f408424dbfa5',
  UCS: '604afa3d8490cc5befe7d6a57f1e61cd',
  VPORT: 'f6ed44612adce47b4eb92bbb6660638d',
  APPID: 'e125c25036686c0c3bd35d56c1791c3a',
  DIMSTYLE: 'b4183e42c99fffe5b6e2cbb375c3c3b0',
  VX: 'e0ca367ccee7586f2b7d745505f1447f',
  blocks: '722b7dec3e8c886c7a720afdc86c8426',
  extras: 'd5f9d3bb0aa969a6cd1c87c7ee804b17',
  second: '298dd149a9731fea99de32f94d0ae019'
} as const;
