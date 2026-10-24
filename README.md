# drizzle-migrate

Aplica as migrations do [Drizzle](https://orm.drizzle.team) num Postgres com o **migrator oficial** do `drizzle-orm`
e recusa as três situações em que uma migration «passa» sem ter corrido.

O Drizzle já faz o essencial, e este pacote não o substitui:

| precisa de | use o Drizzle |
|---|---|
| gerar uma migration a partir do schema | `drizzle-kit generate` |
| escrever SQL à mão | `drizzle-kit generate --custom --name <nome>` (já regista no journal) |
| conferir o histórico | `drizzle-kit check` |
| aplicar | o `migrate()` do `drizzle-orm` — que é o que este pacote chama |

O que ele acrescenta é só o que o migrator não confere e que termina num «OK» falso:

1. **`.sql` fora do `meta/_journal.json`** — o migrator só lê o journal; um ficheiro escrito à mão sem passar pelo
   `generate --custom` é ignorado em silêncio.
2. **`when` fora de ordem no journal** — o migrator aplica só as entradas com `when` maior que o da última aplicada;
   uma entrada com `when` menor é saltada.
3. **migration saltada** — duas pessoas geram migrations em paralelo, a outra aplica a dela (gerada depois) e a sua
   fica com `when` menor que o da última aplicada: o migrator salta-a. Detetada pelo hash ausente da base, numa janela
   de 14 dias.

E lista o que falta aplicar (`--pendentes`), pela mesma regra do migrator.

## Instalar

```bash
pnpm add github:Ricardo-Dinucci/drizzle-migrate#v1.0.0
```

Usa o `drizzle-orm` (≥ 0.45) e o `pg` (8) do próprio projeto.

## Usar

```bash
# aplica; sai ≠ 0 se alguma coisa falhar
DATABASE_URL=… drizzle-migrate src/db/migrations

# só lista o que falta (sai 3 se houver)
DATABASE_URL=… drizzle-migrate src/db/migrations --pendentes

# árvores partilhadas: só aplica .sql que esteja commitado e igual ao commit
DATABASE_URL=… drizzle-migrate src/db/migrations --exigir-git
```

No arranque do servidor, antes da aplicação, sem `|| true`:

```json
"start:prod": "drizzle-migrate src/db/migrations && node dist/main.js"
```

Para ler o `DATABASE_URL` de um ficheiro, use a opção do Node:
`node --env-file-if-exists=.env.local node_modules/.bin/drizzle-migrate …`.

Ligação por proxy com certificado próprio (ex.: o proxy público da Railway): acrescente `?sslmode=no-verify` ao URL.

**Códigos de saída:** `0` ok · `1` falhou · `3` há pendentes (com `--pendentes`) · `4` migration que seria saltada.

Nunca imprime o `DATABASE_URL` (só o host) nem o objeto de erro do `pg` (só a mensagem).

## Pela API

```js
import { migrar, ErroDeMigracao } from '@rcdnc/drizzle-migrate'

const { aplicadas, pendentes } = await migrar({
  pasta: 'src/db/migrations',
  ligacao: { connectionString: process.env.DATABASE_URL },
  soPendentes: false,
  exigirGit: false,
})
```

`ErroDeMigracao.codigo` é um de `JOURNAL_ORFAO`, `WHEN_FORA_DE_ORDEM`, `MIGRATION_SALTADA`, `FORA_DO_GIT`, e
`ErroDeMigracao.itens` diz quais ficheiros.

## Testes

```bash
npm test   # precisa de um Postgres local; TESTE_PG_URL aponta para a base de administração
```
