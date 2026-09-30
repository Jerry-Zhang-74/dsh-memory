/**
 * DSH Memory — local tool definition helper.
 *
 * This plugin deliberately has **no runtime dependencies**: a DSH plugin that
 * imports `@deepseek-ai/dsh-tools` only resolves when the plugin physically
 * lives under the profile's `node_modules`, which breaks as soon as the plugin
 * is developed in (or linked from) another directory. Plugin code only ever
 * needs the *shape* of a tool definition, so this module compiles the
 * author-facing schema subset used here into raw JSON Schema once, at load
 * time, and returns a plain registry-ready object.
 *
 * Supported authoring subset (everything this plugin needs):
 *   { type: 'string'|'number'|'integer'|'boolean'|'null', required?, enum?, const?, description? }
 *   { type: 'array', items?, required? }
 *   { type: 'object', properties?, additionalProperties: boolean, required? }
 *
 * @module dsh-memory/schema
 */

/** Keywords that annotate rather than constrain a value. */
const ANNOTATIONS = ['description', 'title', 'default', 'examples']

/** Copy the annotation keywords shared by every node. */
function annotations(spec) {
  const out = {}
  for (const key of ANNOTATIONS) {
    if (spec[key] !== undefined) out[key] = spec[key]
  }
  return out
}

/** Compile one author-facing value spec into a raw JSON Schema node. */
export function compileValue(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('schema spec must be an object')
  if (spec.type === 'json') return annotations(spec)

  switch (spec.type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      const node = { type: spec.type, ...annotations(spec) }
      if (spec.enum) node.enum = [...spec.enum]
      if (spec.const !== undefined) node.const = spec.const
      return node
    }
    case 'array': {
      const node = { type: 'array', ...annotations(spec) }
      if (spec.items) node.items = compileValue(spec.items)
      return node
    }
    case 'object': {
      if (typeof spec.additionalProperties !== 'boolean') {
        throw new Error('object schema specs must declare additionalProperties explicitly')
      }
      const node = { type: 'object', ...annotations(spec), additionalProperties: spec.additionalProperties }
      const { properties, required } = compilePropertyMap(spec.properties ?? {})
      if (properties) node.properties = properties
      if (required) node.required = required
      return node
    }
    default:
      throw new Error(`unsupported schema type: ${String(spec.type)}`)
  }
}

/** Compile one property map into `{ properties, required }`. */
function compilePropertyMap(map) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(map)) {
    if (typeof key !== 'string') throw new Error('parameter keys must be strings')
    const node = compileValue(spec)
    if (spec && spec.required === true) required.push(key)
    properties[key] = node
  }
  return { properties, required }
}

/**
 * Compile an implicit parameter object. The root is an open object whose
 * requiredness lives on each property, matching the harness convention.
 */
export function compileParameters(spec) {
  const { properties, required } = compilePropertyMap(spec ?? {})
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * Validate candidate arguments against a compiled parameter schema.
 *
 * Deliberately permissive beyond the declared constraints: the model may send
 * extra keys, and the tool body narrows what it needs. A missing required key
 * or a wrong primitive type is reported, because silently coercing those is
 * how a tool ends up recording something the model did not mean.
 *
 * @returns human-readable violations; empty means valid.
 */
export function validateAgainstSchema(schema, args) {
  const violations = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['root must be an object']
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) violations.push(`${key} is required`)
  }
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    const value = args[key]
    if (value === undefined || value === null) continue
    switch (node.type) {
      case 'string':
        if (typeof value !== 'string') violations.push(`${key} must be a string`)
        else if (node.enum && !node.enum.includes(value)) violations.push(`${key} must be one of: ${node.enum.join(', ')}`)
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${key} must be a finite number`)
        break
      case 'integer':
        if (!Number.isInteger(value)) violations.push(`${key} must be an integer`)
        break
      case 'boolean':
        if (typeof value !== 'boolean') violations.push(`${key} must be a boolean`)
        break
      case 'array':
        if (!Array.isArray(value)) violations.push(`${key} must be an array`)
        break
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) violations.push(`${key} must be an object`)
        break
      default:
        break
    }
  }
  return violations
}

/** The category a tool call renders under when it has no bespoke presenter. */
const GENERIC_KIND = 'other'

/**
 * Build a registry-ready tool definition from the author-facing shape.
 *
 * @param options - name, description, parameter specs, output schema/render, and the body.
 * @returns a plain object accepted by `ctx.tools.register`.
 */
export function defineTool(options) {
  const parameters = compileParameters(options.parameters)
  const outputSchema = compileValue(options.output.schema)
  const render = options.output.render

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => render(args, value),
      ...(options.output.presentationMeta ? { presentationMeta: options.output.presentationMeta } : {}),
    },
    async execute(args, exec) {
      const violations = validateAgainstSchema(parameters, args)
      if (violations.length > 0) {
        throw new Error(`invalid arguments for ${options.name}: ${violations.join('; ')}`)
      }
      const value = await options.execute(args ?? {}, exec)
      // A tool whose declared output does not match what it returned is a bug
      // in the tool, not in the caller: fail loud so it surfaces immediately
      // rather than reaching the model as a malformed result.
      const outputViolations = validateAgainstSchema(outputSchema, value)
      if (outputViolations.length > 0) {
        throw new Error(`${options.name} produced an invalid result: ${outputViolations.join('; ')}`)
      }
      return value
    },
    ...(options.presentCall
      ? { presentCall: (args) => options.presentCall(args) ?? { card: 'generic', kind: GENERIC_KIND } }
      : {}),
    ...(options.presentResult ? { presentResult: (args, result) => options.presentResult(args, result) } : {}),
    ...(options.isConcurrencySafe ? { isConcurrencySafe: (args) => options.isConcurrencySafe(args) === true } : {}),
  }
}
