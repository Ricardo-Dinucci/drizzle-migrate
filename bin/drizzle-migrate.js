#!/usr/bin/env node
/**
 * drizzle-migrate <pasta-das-migrations> [--pendentes] [--exigir-git]
 *
 * Liga-se pelo DATABASE_URL. Para o ler de um ficheiro, use a opção do próprio Node:
 *   node --env-file-if-exists=.env.local node_modules/.bin/drizzle-migrate <pasta>
 *
 * Saída: 0 ok · 1 falhou · 3 há pendentes (só com --pendentes) · 4 migration que seria saltada
 */
import { resolve } from 'node:path'
import { migrar, ErroDeMigracao } from '../src/index.js'

const args = process.argv.slice(2)
const pasta = args.find(a => !a.startsWith('--'))
const soPendentes = args.includes('--pendentes')
const exigirGit = args.includes('--exigir-git')

if (!pasta) {
  console.error('uso: drizzle-migrate <pasta-das-migrations> [--pendentes] [--exigir-git]')
  process.exit(1)
}
const url = process.env.DATABASE_URL
if (!url) {
  console.error('[drizzle-migrate] FALHOU — DATABASE_URL não definido')
  process.exit(1)
}

const inicio = Date.now()
// Só o host: o DATABASE_URL leva a senha.
console.log(`[drizzle-migrate] host=${new URL(url).hostname} pasta=${resolve(pasta)}`)

try {
  const r = await migrar({ pasta: resolve(pasta), ligacao: { connectionString: url }, soPendentes, exigirGit })
  if (soPendentes) {
    if (r.pendentes.length === 0) {
      console.log('[drizzle-migrate] nenhuma migration pendente')
      process.exit(0)
    }
    console.error(`[drizzle-migrate] ${r.pendentes.length} migration(s) por aplicar:`)
    for (const t of r.pendentes) console.error(`  - ${t}`)
    process.exit(3)
  }
  for (const t of r.aplicadas) console.log(`[drizzle-migrate] aplicada ${t}`)
  console.log(`[drizzle-migrate] OK (${Date.now() - inicio}ms)`)
  process.exit(0)
} catch (err) {
  if (err instanceof ErroDeMigracao) {
    console.error(`[drizzle-migrate] FALHOU (${err.codigo}) — ${err.message}`)
    for (const i of err.itens) console.error(`  - ${i}`)
    process.exit(err.codigo === 'MIGRATION_SALTADA' ? 4 : 1)
  }
  console.error('[drizzle-migrate] FALHOU')
  // Só a mensagem: o objeto de erro do pg pode trazer a query e os parâmetros.
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
