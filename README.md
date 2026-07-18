# Signal Stream Examples

Runnable examples that consume [Astronomer](https://astronomerapp.com) **Signal Stream** — receiving open trading signals as they're created and turning each one into a broker order.

New to Signal Stream? Start with the [`@astronomer-app/signals`](https://www.npmjs.com/package/@astronomer-app/signals) client.

## Examples

Organized by broker, then language. Each example is **self-contained** — copy the folder, add your keys, and run it.

| Broker | Node | Go | Python |
|--------|------|----|--------|
| Alpaca | [`alpaca/node`](alpaca/node) | _planned_ | _planned_ |
| E*TRADE | _planned_ | — | — |
| Thinkorswim | _planned_ | — | — |

## How these are meant to be used

Each example is a standalone project with its own manifest (`package.json`, `go.mod`, …), its own `README`, and its own `.env.example`. They pin the **published** Signal Stream client, so nothing here depends on any Astronomer internal repo — you can lift a single folder straight into your own service.

Every example runs in a **dry-run** mode with no broker keys (signals are logged, no orders sent) so you can watch the flow before trading. Broker examples default to **paper/sandbox** endpoints.

> ⚠️ These are examples, not production trading systems. Read each example's "Going to production" notes before pointing one at a live account.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout rules and what a new example needs.

## License

[MIT](LICENSE)
