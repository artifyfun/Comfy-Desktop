#!/usr/bin/env python3
"""从 PE 文件(exe/dll)的资源节里提取图标, 存成 .ico。

纯标准库实现(不依赖 pywin32/pefile), 用于在无法调用 System.Drawing 的
受限环境下验证 electron-builder 是否真的把新图标写进了产物 exe。

用法:
    python extract-exe-icon.py <exe路径> <输出ico路径> [--size N]

--size N: 只导出边长 <= N 的最大一档(默认导出全部档位到一个多尺寸 ico)。
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

RT_ICON = 3
RT_GROUP_ICON = 14

ICO_HEADER = struct.Struct("<HHH")  # reserved, type(1=icon), count
ICO_ENTRY = struct.Struct("<BBBBHHII")  # w, h, colorCount, reserved, planes, bitCount, bytesInRes, imageOffset
GRP_ENTRY = struct.Struct("<BBBBHHHI")  # ... 最后两字节是 nId(WORD) + pad


class PE:
    def __init__(self, path: Path):
        self.data = path.read_bytes()
        d = self.data
        if d[:2] != b"MZ":
            raise SystemExit("不是 PE 文件（缺少 MZ 签名）")
        pe_off = struct.unpack_from("<I", d, 0x3C)[0]
        if d[pe_off : pe_off + 4] != b"PE\0\0":
            raise SystemExit("不是 PE 文件（缺少 PE 签名）")
        coff = pe_off + 4
        self.n_sections, _, size_opt = struct.unpack_from("<HH", d, coff + 2)[0], None, struct.unpack_from("<H", d, coff + 16)[0]
        opt = coff + 20
        magic = struct.unpack_from("<H", d, opt)[0]
        self.pe32plus = magic == 0x20B
        # DataDirectory 起点: PE32 = opt+96, PE32+ = opt+112
        dd = opt + (112 if self.pe32plus else 96)
        # 资源表是第 3 项(索引 2), 每项 8 字节(RVA, size)
        self.res_rva, self.res_size = struct.unpack_from("<II", d, dd + 2 * 8)

        # 段表
        sec_off = opt + size_opt
        self.sections = []
        for i in range(self.n_sections):
            base = sec_off + i * 40
            name = d[base : base + 8].rstrip(b"\0").decode("ascii", "replace")
            vsize, vaddr, rawsize, rawptr = struct.unpack_from("<IIII", d, base + 8)
            self.sections.append((name, vaddr, vsize, rawptr, rawsize))

    def rva_to_off(self, rva: int) -> int:
        for _name, vaddr, vsize, rawptr, rawsize in self.sections:
            if vaddr <= rva < vaddr + max(vsize, rawsize):
                return rawptr + (rva - vaddr)
        raise SystemExit(f"RVA 0x{rva:X} 不在任何段内")

    def read(self, off: int, size: int) -> bytes:
        return self.data[off : off + size]


def parse_res_dir(pe: PE, rva: int):
    """解析一层资源目录, 返回 {id: ("dir", 子目录RVA) | ("data", 文件偏移, 大小)}。

    注意: 目录内的 OffsetToDirectory / OffsetToData 都是相对"资源表基 RVA"的,
    不是相对当前目录的文件偏移 —— 叠加到 pe.res_rva 上才是真 RVA。
    """
    entries = {}
    off = pe.rva_to_off(rva)
    named_cnt, id_cnt = struct.unpack_from("<HH", pe.data, off + 12)
    for i in range(named_cnt + id_cnt):
        base = off + 16 + i * 8
        name_field, data_field = struct.unpack_from("<II", pe.data, base)
        if name_field & 0x80000000:  # 名字(字符串), 这里用不到
            continue
        rid = name_field
        if data_field & 0x80000000:  # 子目录
            entries[rid] = ("dir", pe.res_rva + (data_field & 0x7FFFFFFF))
        else:
            # 数据项: 指向 IMAGE_RESOURCE_DATA_ENTRY {OffsetToData(RVA), Size, CodePage, Reserved}
            entry_off = pe.rva_to_off(pe.res_rva + data_field)
            data_rva, size = struct.unpack_from("<II", pe.data, entry_off)
            entries[rid] = ("data", pe.rva_to_off(data_rva), size)
    return entries


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("exe")
    ap.add_argument("out")
    ap.add_argument("--size", type=int, default=0, help="只导出边长 <= N 的最大一档")
    args = ap.parse_args()

    pe = PE(Path(args.exe))
    root = parse_res_dir(pe, pe.res_rva)

    if RT_GROUP_ICON not in root or root[RT_GROUP_ICON][0] != "dir":
        raise SystemExit("exe 内没有图标组资源 (RT_GROUP_ICON)")

    # 资源目录是 Type -> Name -> Language 三层, 数据项挂在最内层
    def first_leaf(type_id: int):
        names = parse_res_dir(pe, root[type_id][1])
        for _rid, nv in names.items():
            if nv[0] != "dir":
                continue
            langs = parse_res_dir(pe, nv[1])
            for _lid, lv in langs.items():
                if lv[0] == "data":
                    yield _rid, lv[1], lv[2]

    groups = list(first_leaf(RT_GROUP_ICON))
    icons = {rid: (off, size) for rid, off, size in first_leaf(RT_ICON)} if RT_ICON in root else {}

    if not groups:
        raise SystemExit("exe 内没有图标组数据")
    # 取第一个图标组(通常只有一个)
    _rid, grp_off, grp_size = groups[0]
    _res, _type, count = ICO_HEADER.unpack_from(pe.data, grp_off)
    print(f"图标组: {count} 档")

    picked = []
    for i in range(count):
        base = grp_off + ICO_HEADER.size + i * 14
        # GRPICONDIRENTRY: bWidth,bHeight,bColorCount,bReserved(4x BYTE)
        # + wPlanes,wBitCount(2x WORD) + dwBytesInRes(DWORD) + nId(WORD) = 14 字节
        w, h, cc, rsv, planes, bits, bytes_in_res, n_id = struct.unpack_from(
            "<BBBBHHIH", pe.data, base
        )
        nid = n_id & 0xFFFF
        if nid not in icons:
            continue
        data_off, data_size = icons[nid]
        picked.append((w if w else 256, h if h else 256, planes, bits, pe.read(data_off, data_size)))

    if not picked:
        raise SystemExit("RT_GROUP_ICON 引用的 RT_ICON 数据缺失")

    if args.size:
        cand = [p for p in picked if p[0] <= args.size]
        picked = [max(cand, key=lambda p: p[0])] if cand else [max(picked, key=lambda p: p[0])]

    out = bytearray()
    out += ICO_HEADER.pack(0, 1, len(picked))
    offset = ICO_HEADER.size + ICO_ENTRY.size * len(picked)
    entries = []
    for w, h, planes, bits, blob in picked:
        entries.append(ICO_ENTRY.pack(w if w < 256 else 0, h if h < 256 else 0, 0, 0, planes, bits, len(blob), offset))
        offset += len(blob)
    for e in entries:
        out += e
    for _w, _h, _p, _b, blob in picked:
        out += blob

    Path(args.out).write_bytes(bytes(out))
    print(f"已写出 {args.out}  档位: {[p[0] for p in picked]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
