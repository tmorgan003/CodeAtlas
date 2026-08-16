// Step 4/5: detect schema/model definitions and turn them into data-dictionary
// entries. Regex-based detection across common ORMs/formats. Anything found
// this way is labeled "auto-detected" — plain-language descriptions are left
// as a placeholder for a human to fill in, since a static scanner can't infer
// business meaning from a field name alone.

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

// Split a string on top-level commas only (ignoring commas nested inside () or {} or []).
function splitTopLevel(str) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function detectSql(relPath, content) {
  const tables = [];
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"'\[]?(\w+)[`"'\]]?\s*\(([\s\S]*?)\)\s*;/gi;
  let m;
  while ((m = tableRe.exec(content))) {
    const tableName = m[1];
    const body = m[2];
    const line = lineOf(content, m.index);
    const fields = [];
    const relationships = [];
    for (const rawLine of splitTopLevel(body)) {
      const line2 = rawLine.trim();
      if (/^(PRIMARY\s+KEY|UNIQUE|INDEX|KEY|CONSTRAINT|CHECK)\b/i.test(line2)) {
        const fkMatch = line2.match(/FOREIGN\s+KEY\s*\(\s*[`"']?(\w+)[`"']?\s*\)\s*REFERENCES\s+[`"']?(\w+)[`"']?\s*\(\s*[`"']?(\w+)[`"']?\s*\)/i);
        if (fkMatch) relationships.push({ field: fkMatch[1], type: 'foreignKey', target: `${fkMatch[2]}.${fkMatch[3]}` });
        continue;
      }
      const colMatch = line2.match(/^[`"']?(\w+)[`"']?\s+([\w()]+)([\s\S]*)$/);
      if (!colMatch) continue;
      const [, name, type, rest] = colMatch;
      const upperRest = rest.toUpperCase();
      const nullable = !upperRest.includes('NOT NULL');
      const unique = upperRest.includes('UNIQUE');
      const isPk = upperRest.includes('PRIMARY KEY');
      const defaultMatch = rest.match(/DEFAULT\s+([^\s,]+)/i);
      const refMatch = rest.match(/REFERENCES\s+[`"']?(\w+)[`"']?\s*\(\s*[`"']?(\w+)[`"']?\s*\)/i);
      const constraints = [];
      if (isPk) constraints.push('primary key');
      if (unique) constraints.push('unique');
      if (refMatch) {
        constraints.push('foreign key');
        relationships.push({ field: name, type: 'foreignKey', target: `${refMatch[1]}.${refMatch[2]}` });
      }
      fields.push({
        name,
        type,
        nullable: isPk ? false : nullable,
        default: defaultMatch ? defaultMatch[1] : null,
        constraints,
        description: '(auto-detected — add description)',
      });
    }
    tables.push({ name: tableName, source: 'sql', file: relPath, line, fields, relationships });
  }
  return tables;
}

function detectPrisma(relPath, content) {
  const models = [];
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = modelRe.exec(content))) {
    const name = m[1];
    const line = lineOf(content, m.index);
    const fields = [];
    const relationships = [];
    const body = m[2];
    for (const rawLine of body.split('\n')) {
      const l = rawLine.trim();
      if (!l || l.startsWith('//') || l.startsWith('@@')) continue;
      const fieldMatch = l.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
      if (!fieldMatch) continue;
      const [, fname, ftype, isArray, isOptional, attrs] = fieldMatch;
      const constraints = [];
      if (/@id\b/.test(attrs)) constraints.push('primary key');
      if (/@unique\b/.test(attrs)) constraints.push('unique');
      if (/@relation\b/.test(attrs)) {
        constraints.push('foreign key / relation');
        relationships.push({ field: fname, type: 'relation', target: ftype + (isArray ? '[]' : '') });
      }
      const defaultMatch = attrs.match(/@default\(([^)]*)\)/);
      fields.push({
        name: fname,
        type: ftype + (isArray ? '[]' : ''),
        nullable: !!isOptional,
        default: defaultMatch ? defaultMatch[1] : null,
        constraints,
        description: '(auto-detected — add description)',
      });
    }
    models.push({ name, source: 'prisma', file: relPath, line, fields, relationships });
  }
  return models;
}

function detectMongoose(relPath, content) {
  const models = [];
  const schemaRe = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:mongoose\.)?Schema\(\s*\{([\s\S]*?)\}\s*(?:,|\))/g;
  let m;
  while ((m = schemaRe.exec(content))) {
    const varName = m[1];
    const line = lineOf(content, m.index);
    const body = m[2];
    const fields = [];
    for (const part of splitTopLevel(body)) {
      const keyMatch = part.match(/^["']?(\w+)["']?\s*:\s*([\s\S]+)$/);
      if (!keyMatch) continue;
      const [, fname, valueRaw] = keyMatch;
      const typeMatch = valueRaw.match(/type\s*:\s*([\w.]+)/);
      const simpleTypeMatch = valueRaw.match(/^([\w.]+)$/);
      const type = typeMatch ? typeMatch[1] : (simpleTypeMatch ? simpleTypeMatch[1] : 'Mixed');
      const required = /required\s*:\s*true/.test(valueRaw);
      const unique = /unique\s*:\s*true/.test(valueRaw);
      const defaultMatch = valueRaw.match(/default\s*:\s*([^\s,}]+)/);
      const constraints = [];
      if (unique) constraints.push('unique');
      fields.push({
        name: fname,
        type,
        nullable: !required,
        default: defaultMatch ? defaultMatch[1] : null,
        constraints,
        description: '(auto-detected — add description)',
      });
    }
    models.push({ name: varName, source: 'mongoose', file: relPath, line, fields, relationships: [] });
  }
  return models;
}

function detectDjango(relPath, content) {
  const models = [];
  const classRe = /class\s+(\w+)\(models\.Model\)\s*:([\s\S]*?)(?=\nclass\s|\Z)/g;
  let m;
  while ((m = classRe.exec(content))) {
    const name = m[1];
    const line = lineOf(content, m.index);
    const body = m[2];
    const fields = [];
    const relationships = [];
    const fieldRe = /^\s*(\w+)\s*=\s*models\.(\w+)\(([^)]*)\)/gm;
    let fm;
    while ((fm = fieldRe.exec(body))) {
      const [, fname, ftype, args] = fm;
      const nullable = /null\s*=\s*True/.test(args);
      const unique = /unique\s*=\s*True/.test(args);
      const defaultMatch = args.match(/default\s*=\s*([^\s,)]+)/);
      const constraints = [];
      if (unique) constraints.push('unique');
      if (ftype === 'ForeignKey' || ftype === 'OneToOneField' || ftype === 'ManyToManyField') {
        constraints.push('foreign key');
        const targetMatch = args.match(/^['"]?(\w+)['"]?/);
        relationships.push({ field: fname, type: ftype, target: targetMatch ? targetMatch[1] : '?' });
      }
      fields.push({
        name: fname,
        type: ftype,
        nullable,
        default: defaultMatch ? defaultMatch[1] : null,
        constraints,
        description: '(auto-detected — add description)',
      });
    }
    models.push({ name, source: 'django', file: relPath, line, fields, relationships });
  }
  return models;
}

function detectTypeOrm(relPath, content) {
  if (!/@Entity\(/.test(content)) return [];
  const models = [];
  const entityRe = /@Entity\(([^)]*)\)\s*\n\s*(?:export\s+)?class\s+(\w+)/g;
  let m;
  const matches = [];
  while ((m = entityRe.exec(content))) matches.push({ index: m.index, name: m[2] });
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const block = content.slice(start, end);
    const fields = [];
    const relationships = [];
    const colRe = /@(Column|PrimaryGeneratedColumn|PrimaryColumn)\(([^)]*)\)\s*\n\s*(\w+)\s*(?::\s*([\w<>\[\].]+))?/g;
    let cm;
    while ((cm = colRe.exec(block))) {
      const [, decorator, args, fname, ftype] = cm;
      const constraints = [];
      if (decorator.includes('Primary')) constraints.push('primary key');
      if (/unique\s*:\s*true/.test(args)) constraints.push('unique');
      const nullable = /nullable\s*:\s*true/.test(args);
      const defaultMatch = args.match(/default\s*:\s*([^\s,}]+)/);
      fields.push({
        name: fname,
        type: ftype || 'unknown',
        nullable,
        default: defaultMatch ? defaultMatch[1] : null,
        constraints,
        description: '(auto-detected — add description)',
      });
    }
    const relRe = /@(OneToMany|ManyToOne|ManyToMany|OneToOne)\(([^)]*)\)\s*\n\s*(\w+)/g;
    let rm;
    while ((rm = relRe.exec(block))) {
      relationships.push({ field: rm[3], type: rm[1], target: rm[2].split(',')[0].trim() });
    }
    models.push({ name: matches[i].name, source: 'typeorm', file: relPath, line: lineOf(content, start), fields, relationships });
  }
  return models;
}

function detectDataModels(relPath, content, ext) {
  const results = [];
  if (ext === '.sql') results.push(...detectSql(relPath, content));
  if (relPath.endsWith('.prisma')) results.push(...detectPrisma(relPath, content));
  if (ext === '.js' || ext === '.ts') {
    if (/new\s+(?:mongoose\.)?Schema\(/.test(content)) results.push(...detectMongoose(relPath, content));
    if (/@Entity\(/.test(content)) results.push(...detectTypeOrm(relPath, content));
  }
  if (ext === '.py' && /models\.Model/.test(content)) results.push(...detectDjango(relPath, content));
  return results;
}

module.exports = { detectDataModels };
