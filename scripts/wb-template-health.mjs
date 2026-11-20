/**
 * 模板健康自检（只读，不提交任何执行）。
 *
 * 背景：2026-09-16 真机验证发现既有 app 的模板会和**本机已安装的节点版本**漂移——
 * 例如 Anima 系的 4 个 `Load Text File` 连了一个本机节点根本没有的输入口
 * （`file_path`），又缺了它现在必需的 widget（`file`）。ComfyUI 对此的处置是：
 * **把该节点的整条输出分支静默丢弃**（只要还有别的输出节点通过校验就仍返回 200），
 * 于是表现为「执行成功但没有正式产物」。
 *
 * 本脚本用本机 `/object_info` 对照每个模板的 prompt，静态找出两类漂移：
 *   - `required_missing`：节点必需的输入没给（无 default）→ ComfyUI 会丢分支
 *   - `input_not_in_node`：连了一个本机节点不存在的输入口 → 链路被静默忽略
 *
 * 用法：node scripts/wb-template-health.mjs [--app http://127.0.0.1:3008]
 */
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const APP = opt('--app', 'http://127.0.0.1:3008').replace(/\/$/, '')
const COMFY = opt('--comfy', 'http://127.0.0.1:8188').replace(/\/$/, '')

const tpls = (await (await fetch(`${APP}/api/workbench/templates`)).json()).data || []
const oi = await (await fetch(`${COMFY}/object_info`)).json()

console.log(`本机 ComfyUI 节点类 ${Object.keys(oi).length} 个；模板 ${tpls.length} 个\n`)

let broken = 0
const summary = []
for (const t of tpls) {
  const prompt = t.prompt || {}
  const problems = []
  const unknownClasses = new Set()
  for (const [nid, node] of Object.entries(prompt)) {
    const cls = node?.class_type
    const info = oi[cls]
    if (!info) {
      unknownClasses.add(cls)
      continue
    }
    const req = info.input?.required ?? {}
    const declared = new Set([...Object.keys(req), ...Object.keys(info.input?.optional ?? {})])
    const provided = new Set(Object.keys(node.inputs ?? {}))
    for (const extra of [...provided].filter((x) => !declared.has(x)).sort()) {
      problems.push({ nid, cls, kind: 'input_not_in_node', name: extra })
    }
    for (const miss of [...Object.keys(req)].filter((x) => !provided.has(x)).sort()) {
      const spec = req[miss]
      if (Array.isArray(spec) && spec[1] && typeof spec[1] === 'object' && 'default' in spec[1]) {
        continue
      }
      problems.push({ nid, cls, kind: 'required_missing', name: miss })
    }
  }
  const clean = !problems.length && !unknownClasses.size
  if (!clean) broken++
  console.log(
    `${clean ? 'OK ' : 'NG '} ${String(t.name).padEnd(30)} 节点=${String(Object.keys(prompt).length).padEnd(4)} mediaType=${String(t.mediaType).padEnd(6)} id=${t.id}`
  )
  for (const cls of unknownClasses) console.log(`     未安装的节点类：${cls}`)
  // 同类问题只打一行（节点多时噪音太大）
  const seen = new Set()
  for (const p of problems) {
    const key = `${p.cls}|${p.kind}|${p.name}`
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`     ${p.nid} ${p.cls} → ${p.kind} ${p.name}`)
  }
  summary.push({ name: t.name, id: t.id, clean, problemCount: problems.length })
}

console.log(
  `\n════ 汇总 ════\n共 ${tpls.length} 个模板，健康 ${tpls.length - broken}，存在节点版本漂移 ${broken}`
)
for (const s of summary.filter((x) => !x.clean)) {
  console.log(`  NG ${s.name}（${s.problemCount} 处）`)
}
process.exitCode = broken ? 1 : 0
