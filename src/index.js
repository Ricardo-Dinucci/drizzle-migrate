/**
 * Migrations do Drizzle que nunca "passam" sem correr.
 *
 * Quem aplica é o `migrate()` do drizzle-orm, e quem lê o journal e calcula os hashes é o `readMigrationFiles()` do
 * mesmo pacote — exatamente o que o migrator usa. Este módulo só acrescenta o que o Drizzle não confere e que, quando
 * acontece, termina num "OK" sem que a migration tenha corrido:
 *
 * 1. `.sql` na pasta que não está no `meta/_journal.json` (escrito à mão fora do `drizzle-kit generate --custom`);
 * 2. `when` fora de ordem no journal (o migrator só aplica o que tem `when` maior que o último aplicado);
 * 3. migration com `when` menor que o da última aplicada e hash ausente da base — outra pessoa aplicou uma migration
 *    gerada depois da sua, e o migrator salta a sua.
 *
 * E lista o que falta aplicar (`pendentes`), com a mesma regra do migrator.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'

export class ErroDeMigracao extends Error {
  /**
   * @param {'JOURNAL_ORFAO'|'WHEN_FORA_DE_ORDEM'|'MIGRATION_SALTADA'|'FORA_DO_GIT'|'FALHOU'} codigo
   * @param {string} mensagem
   * @param {string[]} [itens]
   */
  constructor(codigo, mensagem, itens = []) {
    super(mensagem)
    this.name = 'ErroDeMigracao'
    this.codigo = codigo
    this.itens = itens
  }
}

const lerEntradas = pasta =>
  JSON.parse(readFileSync(join(pasta, 'meta', '_journal.json'), 'utf8')).entries ?? []

/** Junta a tag de cada entrada do journal ao que o drizzle-orm lê dela (hash e `when`). */
export function lerMigrations(pasta) {
  const entradas = lerEntradas(pasta)
  return readMigrationFiles({ migrationsFolder: pasta }).map((m, i) => ({
    tag: entradas[i].tag,
    when: Number(m.folderMillis),
    hash: m.hash,
  }))
}

/** 1. `.sql` que o migrator ignoraria em silêncio por não estar no journal. */
export function conferirJournal(pasta) {
  const registadas = new Set(lerEntradas(pasta).map(e => e.tag))
  const orfas = readdirSync(pasta)
    .filter(f => f.endsWith('.sql'))
    .map(f => f.replace(/\.sql$/, ''))
    .filter(tag => !registadas.has(tag))
  if (orfas.length) {
    throw new ErroDeMigracao(
      'JOURNAL_ORFAO',
      '.sql fora do meta/_journal.json — não seria aplicado. Crie as migrations à mão com ' +
        '`drizzle-kit generate --custom --name <nome>`, que já as regista.',
      orfas.map(t => `${t}.sql`)
    )
  }
}

/** 2. `when` que não cresce: a entrada seria saltada em silêncio. */
export function conferirOrdem(migrations) {
  const quebras = []
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].when <= migrations[i - 1].when) {
      quebras.push(`${migrations[i].tag} (when ${migrations[i].when}) depois de ${migrations[i - 1].tag} (when ${migrations[i - 1].when})`)
    }
  }
  if (quebras.length) {
    throw new ErroDeMigracao(
      'WHEN_FORA_DE_ORDEM',
      '`when` fora de ordem no journal — o migrator saltaria a entrada. O `when` de cada entrada tem de ser maior que o da anterior.',
      quebras
    )
  }
}

async function lerAplicadas(pool, tabela) {
  try {
    const { rows } = await pool.query(`SELECT hash, created_at::bigint AS em FROM ${tabela}`)
    return rows.map(r => ({ hash: r.hash, em: Number(r.em) }))
  } catch (err) {
    if (err && err.code === '42P01') return [] // a tabela de registo ainda não existe: base nova
    throw err
  }
}

/**
 * 3. Migration com `when` menor que o da última aplicada e hash ausente da base. Só olha a janela recente: em
 * histórico antigo o `created_at` gravado pode não coincidir com o `when` e acusaria falsos positivos.
 */
export function procurarSaltadas(migrations, aplicadas, janelaDias = 14) {
  const hashes = new Set(aplicadas.map(a => a.hash))
  const ultimo = Math.max(0, ...aplicadas.map(a => a.em))
  const inicio = ultimo - janelaDias * 24 * 3600 * 1000
  return migrations.filter(m => m.when <= ultimo && m.when >= inicio && !hashes.has(m.hash))
}

/** O que o migrator aplicaria agora: tudo o que tem `when` maior que o último aplicado. */
export function listarPendentes(migrations, aplicadas) {
  const ultimo = Math.max(0, ...aplicadas.map(a => a.em))
  return migrations.filter(m => m.when > ultimo)
}

/** Opcional: pendente só se aplica se o `.sql` estiver no git, igual ao commit (árvores partilhadas). */
export function conferirGit(pasta, pendentes) {
  const git = (...a) => spawnSync('git', a, { cwd: pasta, encoding: 'utf8' })
  const dentro = git('rev-parse', '--is-inside-work-tree')
  if (dentro.error || dentro.status !== 0) return { conferido: false }
  const ruins = []
  for (const m of pendentes) {
    const f = `${m.tag}.sql`
    if (git('ls-files', '--error-unmatch', '--', f).status !== 0) ruins.push(`${f} (fora do git)`)
    else if (git('diff', '--quiet', 'HEAD', '--', f).status !== 0) ruins.push(`${f} (diferente do commit)`)
  }
  if (ruins.length) {
    throw new ErroDeMigracao('FORA_DO_GIT', 'migration pendente que não é a do commit — commite o .sql e a linha do journal.', ruins)
  }
  return { conferido: true }
}

/**
 * Confere e aplica.
 *
 * @param {object} opcoes
 * @param {string} opcoes.pasta            pasta das migrations (a que tem `meta/_journal.json`)
 * @param {pg.PoolConfig} [opcoes.ligacao] configuração do `pg.Pool`, ex. `{ connectionString }`; sem ela, o `pg` usa
 *                                         as variáveis PG* do ambiente
 * @param {boolean} [opcoes.soPendentes]   só lista o que falta, sem aplicar
 * @param {boolean} [opcoes.exigirGit]     recusa pendente que não esteja commitada
 * @param {number}  [opcoes.janelaDias]    janela da verificação de saltadas (14)
 * @param {string}  [opcoes.migrationsSchema] schema da tabela de registo ('drizzle')
 * @param {string}  [opcoes.migrationsTable]  tabela de registo ('__drizzle_migrations')
 * @returns {Promise<{ pendentes: string[], aplicadas: string[] }>}
 */
export async function migrar(opcoes) {
  const {
    pasta,
    ligacao = {},
    soPendentes = false,
    exigirGit = false,
    janelaDias = 14,
    migrationsSchema = 'drizzle',
    migrationsTable = '__drizzle_migrations',
  } = opcoes
  if (!pasta) throw new ErroDeMigracao('FALHOU', 'falta a pasta das migrations')

  conferirJournal(pasta)
  const migrations = lerMigrations(pasta)
  conferirOrdem(migrations)

  const pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 30_000, ...ligacao })
  try {
    const aplicadas = await lerAplicadas(pool, `"${migrationsSchema}"."${migrationsTable}"`)
    const saltadas = procurarSaltadas(migrations, aplicadas, janelaDias)
    if (saltadas.length) {
      throw new ErroDeMigracao(
        'MIGRATION_SALTADA',
        'migration que o migrator saltaria em silêncio: tem `when` menor que o da última aplicada. Outra pessoa ' +
          'aplicou uma migration gerada depois desta — atualize a árvore, apague esta (.sql, snapshot e linha do ' +
          'journal) e gere de novo. Se o hash mudou porque o .sql já aplicado foi editado, desfaça a edição.',
        saltadas.map(m => m.tag)
      )
    }
    const pendentes = listarPendentes(migrations, aplicadas)
    if (soPendentes || pendentes.length === 0) {
      return { pendentes: pendentes.map(m => m.tag), aplicadas: [] }
    }
    if (exigirGit) conferirGit(pasta, pendentes)
    await migrate(drizzle(pool), { migrationsFolder: pasta, migrationsSchema, migrationsTable })
    return { pendentes: [], aplicadas: pendentes.map(m => m.tag) }
  } finally {
    await pool.end().catch(() => {})
  }
}
