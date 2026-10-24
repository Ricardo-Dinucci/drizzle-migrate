// Corre contra um Postgres local: cada teste cria a sua base e apaga-a no fim.
// TESTE_PG_URL aponta para a base de administração (omissão: postgresql://localhost:5432/postgres).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { migrar, ErroDeMigracao } from '../src/index.js'

const ADMIN = process.env.TESTE_PG_URL ?? 'postgresql://localhost:5432/postgres'

async function comBase(fn) {
  const nome = `drizzle_migrate_teste_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  const admin = new pg.Client({ connectionString: ADMIN })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${nome}"`)
  const url = new URL(ADMIN)
  url.pathname = `/${nome}`
  try {
    await fn(url.toString())
  } finally {
    await admin.query(`DROP DATABASE "${nome}" WITH (FORCE)`)
    await admin.end()
  }
}

/** Pasta de migrations com o journal; `ficheiros` = [{ tag, when, sql, noJournal? }]. */
function pastaCom(ficheiros) {
  const pasta = mkdtempSync(join(tmpdir(), 'drizzle-migrate-'))
  mkdirSync(join(pasta, 'meta'))
  const entries = ficheiros
    .filter(f => !f.noJournal)
    .map((f, idx) => ({ idx, version: '7', when: f.when, tag: f.tag, breakpoints: true }))
  writeFileSync(join(pasta, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }))
  for (const f of ficheiros) writeFileSync(join(pasta, `${f.tag}.sql`), f.sql)
  return pasta
}

const consultar = async (url, q) => {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    return (await c.query(q)).rows
  } finally {
    await c.end()
  }
}

const A = { tag: '0000_a', when: 1000, sql: 'CREATE TABLE a (id int);' }
const B = { tag: '0001_b', when: 2000, sql: 'CREATE TABLE b (id int);\n--> statement-breakpoint\nALTER TABLE b ADD COLUMN x int;' }

test('aplica as pendentes, regista-as e não volta a aplicar', async () => {
  await comBase(async url => {
    const pasta = pastaCom([A, B])
    const ligacao = { connectionString: url }
    assert.deepEqual(await migrar({ pasta, ligacao, soPendentes: true }), { pendentes: ['0000_a', '0001_b'], aplicadas: [] })
    assert.deepEqual(await migrar({ pasta, ligacao }), { pendentes: [], aplicadas: ['0000_a', '0001_b'] })
    assert.equal((await consultar(url, "SELECT 1 FROM information_schema.columns WHERE table_name='b' AND column_name='x'")).length, 1)
    assert.deepEqual(await migrar({ pasta, ligacao }), { pendentes: [], aplicadas: [] })
    assert.equal((await consultar(url, 'SELECT count(*)::int n FROM drizzle.__drizzle_migrations'))[0].n, 2)
    rmSync(pasta, { recursive: true })
  })
})

test('recusa .sql fora do journal antes de tocar na base', async () => {
  const pasta = pastaCom([A, { tag: '0001_feita_a_mao', when: 2000, sql: 'SELECT 1;', noJournal: true }])
  await assert.rejects(
    migrar({ pasta, ligacao: { connectionString: 'postgresql://nao-existe.invalid/x' } }),
    e => e instanceof ErroDeMigracao && e.codigo === 'JOURNAL_ORFAO' && e.itens[0] === '0001_feita_a_mao.sql'
  )
  rmSync(pasta, { recursive: true })
})

test('recusa `when` fora de ordem', async () => {
  const pasta = pastaCom([A, { ...B, when: 500 }])
  await assert.rejects(
    migrar({ pasta, ligacao: { connectionString: 'postgresql://nao-existe.invalid/x' } }),
    e => e instanceof ErroDeMigracao && e.codigo === 'WHEN_FORA_DE_ORDEM'
  )
  rmSync(pasta, { recursive: true })
})

test('recusa a migration que o migrator saltaria (gerada antes da última aplicada)', async () => {
  await comBase(async url => {
    const ligacao = { connectionString: url }
    // Outra pessoa aplicou a 0002 (when 3000); a minha 0001 (when 2000) ainda não está na base.
    const C = { tag: '0002_c', when: 3000, sql: 'CREATE TABLE c (id int);' }
    const pastaDeles = pastaCom([A, C])
    await migrar({ pasta: pastaDeles, ligacao })
    const pastaMinha = pastaCom([A, B, C])
    await assert.rejects(
      migrar({ pasta: pastaMinha, ligacao }),
      e => e instanceof ErroDeMigracao && e.codigo === 'MIGRATION_SALTADA' && e.itens.join() === '0001_b'
    )
    assert.equal((await consultar(url, "SELECT to_regclass('public.b') IS NULL vazia"))[0].vazia, true)
    rmSync(pastaDeles, { recursive: true })
    rmSync(pastaMinha, { recursive: true })
  })
})

test('migration que falha sai com erro e não fica registada', async () => {
  await comBase(async url => {
    const pasta = pastaCom([A, { tag: '0001_ma', when: 2000, sql: 'ALTER TABLE nao_existe ADD COLUMN y int;' }])
    await assert.rejects(migrar({ pasta, ligacao: { connectionString: url } }), /nao_existe/)
    const registadas = await consultar(url, 'SELECT count(*)::int n FROM drizzle.__drizzle_migrations')
    assert.equal(registadas[0].n, 0) // o migrator corre tudo numa transação
    rmSync(pasta, { recursive: true })
  })
})
