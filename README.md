# stately-github-app

> A GitHub App built with [Probot](https://github.com/probot/probot) that An app for visualising XState machines in GitHub

## Setup

```sh
# Install dependencies
npm install

# Run the bot
npm start
```

## Docker

```sh
# 1. Build container
docker build -t stately-github-app .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> stately-github-app
```

## Contributing

If you have suggestions for how stately-github-app could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2021 Matt Pocock <mattpocockvoice@gmail.com>
