import type { PoolConfig } from 'pg'

export type CodigoDeErro = 'JOURNAL_ORFAO' | 'WHEN_FORA_DE_ORDEM' | 'MIGRATION_SALTADA' | 'FORA_DO_GIT' | 'FALHOU'

export class ErroDeMigracao extends Error {
  constructor(codigo: CodigoDeErro, mensagem: string, itens?: string[])
  readonly codigo: CodigoDeErro
  /** os ficheiros (ou tags) em causa */
  readonly itens: string[]
}

export interface Migration {
  tag: string
  when: number
  hash: string
}

export interface OpcoesDeMigrar {
  /** pasta das migrations (a que tem `meta/_journal.json`) */
  pasta: string
  /** configuração do `pg.Pool`, ex. `{ connectionString }`; sem ela, o `pg` usa as variáveis PG* */
  ligacao?: PoolConfig
  /** só lista o que falta, sem aplicar */
  soPendentes?: boolean
  /** recusa pendente que não esteja commitada e igual ao commit */
  exigirGit?: boolean
  /** janela da verificação de migrations saltadas, em dias (14) */
  janelaDias?: number
  /** schema da tabela de registo ('drizzle') */
  migrationsSchema?: string
  /** tabela de registo ('__drizzle_migrations') */
  migrationsTable?: string
}

export function migrar(opcoes: OpcoesDeMigrar): Promise<{ pendentes: string[]; aplicadas: string[] }>
export function lerMigrations(pasta: string): Migration[]
export function conferirJournal(pasta: string): void
export function conferirOrdem(migrations: Migration[]): void
export function procurarSaltadas(
  migrations: Migration[],
  aplicadas: { hash: string; em: number }[],
  janelaDias?: number,
): Migration[]
export function listarPendentes(migrations: Migration[], aplicadas: { hash: string; em: number }[]): Migration[]
export function conferirGit(pasta: string, pendentes: Migration[]): { conferido: boolean }
