// 机械校验内核：结构校验（validate_prompt.py 的 JS 移植）+ 冻结度比对（路径 B 程序化自检）。
// 创作边界：这里只拦机械事故（结构/类型/逐字一致性），不判断画面好坏、不做创作建议。
// 结果一律「报告不拦截」——校验不通过时工具回执清单，交给 agent/用户决定怎么改。

// (路径, 说明)；路径以 '.' 分隔，空列表表示顶层字符串字段
const REQUIRED_STR_FIELDS = [
  ['风格模式', '顶层画风定调'],
  ['画面气质', '情绪/氛围关键词'],
  ['场景.环境.地点设定', '具体地点'],
  ['场景.环境.光线', '布光术语'],
  ['场景.环境.天气氛围', '季节时间与空气感'],
  ['场景.主体.整体描述', '主体身份与类别'],
  ['场景.主体.外形特征.身材', '体型'],
  ['场景.主体.外形特征.面部', '面容特征'],
  ['场景.主体.外形特征.头发', '发型发色'],
  ['场景.主体.外形特征.眼睛', '瞳色眼神'],
  ['场景.主体.表情与动作.情绪', '情绪词'],
  ['场景.主体.表情与动作.动作', '完整动作链'],
  ['场景.主体.服装.穿着', '配色形制'],
  ['场景.主体.服装.细节', '材质装饰'],
  ['场景.主体.配饰', '点缀物'],
  ['场景.背景.描述', '背景内容'],
  ['场景.背景.景深', '虚化强度'],
  ['相机.机位角度', '视角'],
  ['相机.构图', '景别与取舍'],
  ['相机.镜头特性', '焦段'],
  ['相机.传感器画质', '画质声明'],
  ['审美控制.呈现意图', '成品定位'],
  ['审美控制.色彩风格.整体色调', '主色点缀'],
  ['审美控制.色彩风格.对比度', '明暗风格'],
  ['审美控制.色彩风格.特殊效果', '粒子光效等'],
]

const TOP_LEVEL_SECTIONS = ['风格模式', '画面气质', '场景', '相机', '审美控制']

/** 按 'a.b.c' 取嵌套值，不存在返回 [false, null]。 */
export function getByPath(data, path) {
  let node = data
  for (const key of String(path).split('.')) {
    if (!node || typeof node !== 'object' || !(key in node)) return [false, null]
    node = node[key]
  }
  return [true, node]
}

/** 提示词解析：接受对象或 JSON 字符串；字符串解析失败抛错（工具层转回执）。 */
export function parsePrompt(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input
  const text = String(input ?? '').trim()
  if (!text) throw new Error('提示词为空')
  // 容错：agent 偶尔会带 ```json 围栏——剥掉再解析（围栏本身是校验要拦的机械事故）
  let body = text
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body)
  if (fence) body = fence[1]
  try {
    return JSON.parse(body)
  } catch (err) {
    throw new Error(`JSON 解析失败：${err.message}`)
  }
}

/**
 * 结构校验（完整/部分双模式）。
 * 返回 { errors: string[], warnings: string[], checkedFields, passed }。
 */
export function validatePrompt(data, { partial = false } = {}) {
  const errors = []
  const warnings = []
  let checkedFields = 0

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: ['根节点必须是 JSON 对象'], warnings, checkedFields: 0, passed: false }
  }

  // 顶层小节
  for (const section of TOP_LEVEL_SECTIONS) {
    const [exists, value] = getByPath(data, section)
    if (!exists || value === null || value === '' || (typeof value === 'object' && !Object.keys(value ?? {}).length)) {
      const msg = `缺少顶层字段: ${section}`
      ;(partial ? warnings : errors).push(msg)
      if (exists) checkedFields += 1
    } else {
      checkedFields += 1
    }
  }

  // 必需字符串字段
  for (const [path, desc] of REQUIRED_STR_FIELDS) {
    const [exists, value] = getByPath(data, path)
    if (!exists) {
      if (!partial) errors.push(`缺少字段: ${path}（${desc}）`)
      continue
    }
    checkedFields += 1
    if (typeof value !== 'string') {
      errors.push(`类型错误: ${path} 应为字符串，实际为 ${typeof value}`)
    } else if (!value.trim()) {
      errors.push(`空值: ${path}（${desc}）不能为空`)
    }
  }

  // 材质真实度：必须为非空字符串数组（与上游 validate_prompt.py 对齐：缺失只在部分模式提示，不算硬错误）
  const [hasMaterial, material] = getByPath(data, '审美控制.材质真实度')
  if (hasMaterial) {
    checkedFields += 1
    if (!Array.isArray(material)) {
      errors.push(`类型错误: 审美控制.材质真实度 应为数组，实际为 ${typeof material}`)
    } else if (!material.length) {
      errors.push('空值: 审美控制.材质真实度 至少需要 1 条')
    } else if (!material.every((item) => typeof item === 'string' && item.trim())) {
      errors.push('审美控制.材质真实度 数组中存在空串或非字符串元素')
    }
  } else if (!partial) {
    warnings.push('缺少字段: 审美控制.材质真实度（材质分述数组；字段规范要求必填）')
  }

  // 层级健全性：嵌套小节若存在必须是对象
  for (const path of [
    '场景', '场景.环境', '场景.主体', '场景.主体.外形特征',
    '场景.主体.表情与动作', '场景.主体.服装', '场景.背景',
    '相机', '审美控制', '审美控制.色彩风格',
  ]) {
    const [exists, value] = getByPath(data, path)
    if (exists && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      errors.push(`类型错误: ${path} 应为对象，实际为 ${Array.isArray(value) ? 'array' : typeof value}`)
    }
  }

  return { errors, warnings, checkedFields, passed: errors.length === 0 }
}

/** 展平成叶子路径 → 原值。数组按下标展开；空数组/空对象视作一个叶子（值为序列化形式）。 */
export function flattenLeaves(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) {
    if (!value.length) {
      out.set(prefix, '[]')
      return out
    }
    value.forEach((item, index) => flattenLeaves(item, prefix ? `${prefix}.${index}` : String(index), out))
    return out
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (!keys.length) {
      out.set(prefix, '{}')
      return out
    }
    for (const key of keys) flattenLeaves(value[key], prefix ? `${prefix}.${key}` : key, out)
    return out
  }
  out.set(prefix, value === undefined || value === null ? String(value) : String(value))
  return out
}

/**
 * 冻结度比对（路径 B 自检）：两份提示词展平成叶子字段逐一比对。
 * 返回 { changed: [{path, before, after}], frozen: string[], added: string[], removed: string[], totalLeaves, frozenRate }。
 * 「改动是否落在用户意图覆盖的节点上」的判断归 agent（创作边界），本函数只做逐字一致性比对。
 */
export function diffPrompts(before, after) {
  const left = flattenLeaves(before)
  const right = flattenLeaves(after)
  const changed = []
  const frozen = []
  const added = []
  const removed = []
  for (const [path, value] of left) {
    if (right.has(path)) {
      if (right.get(path) === value) frozen.push(path)
      else changed.push({ path, before: value, after: right.get(path) })
    } else {
      removed.push(path)
    }
  }
  for (const path of right.keys()) {
    if (!left.has(path)) added.push(path)
  }
  const totalLeaves = frozen.length + changed.length
  const frozenRate = totalLeaves ? Math.round((frozen.length / totalLeaves) * 100) : 0
  return { changed, frozen, added, removed, totalLeaves, frozenRate }
}
