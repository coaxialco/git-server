# Git Server

A configurable Git server written in Node.js, designed for developers, DevOps engineers, and system administrators.

## Table of Contents

1. [Introduction](#introduction)
2. [Installation](#installation)
3. [Getting Started](#getting-started)
4. [Basic Usage](#basic-usage)
5. [Advanced Usage](#advanced-usage)
6. [Core Components](#core-components)
7. [Configuration Options](#configuration-options)
8. [Event Handling](#event-handling)
9. [Integration with CI/CD](#integration-with-cicd)
10. [Security Considerations](#security-considerations)
11. [Testing](#testing)
12. [Contributing](#contributing)
13. [Community and Support](#community-and-support)
14. [License](#license)

## Introduction

The Git Server is a lightweight, configurable server for managing Git repositories. It is suitable for developers needing a local or private Git server, DevOps engineers integrating version control into CI/CD pipelines, and system administrators managing internal development tools.

## Functionality and Features

- **Customizable Authentication**: Set up authentication for push and fetch operations using a flexible authentication function.
- **Event-Driven Architecture**: Handle events like `push`, `fetch`, `tag`, `head`, and `info` to customize server behavior.
- **Auto-Create Repositories**: Automatically create repositories on demand if they do not exist.
- **CI/CD Integration**: Seamlessly integrate with CI/CD pipelines for automated workflows.
- **Error Handling**: Built-in mechanisms for handling errors, including custom error events and detailed logging.

## Installation

### Prerequisites

- Node.js version 16 or higher.

### Steps

1. Clone the repository:

   ```bash
   git clone https://github.com/yourusername/git-server.git
   cd git-server
   ```

2. Install dependencies:

   ```bash
   yarn install
   ```

3. Build the project:
   ```bash
   yarn build
   ```

## Getting Started

Quick start guide to get your Git server running:

1. **Start the Server**:

   ```typescript
   import { GitServer } from './dist/index.js';

   const server = new GitServer('/path/to/repositories', {
     autoCreate: true,
     authenticate: async (type, repo, username, password) => {
       // Implement authentication logic
     },
   });

   server.listen(8080);
   console.log('Git server is running on port 8080');
   ```

2. **Clone a Repository**:
   ```bash
   git clone http://localhost:8080/my-repo
   ```

## Basic Usage

- **Cloning a Repository**: Use the Git clone command with the server URL.
- **Pushing Changes**: Push changes to the server using Git's push command.

## Advanced Usage

### Authentication

Set up custom authentication by providing an `authenticate` function in the server options.

### Event Handling

Listen for and handle events such as `push`, `fetch`, and `tag` to customize server behavior.

### Production Deployment

Configure the server for production use with environment-specific settings.

## Core Components

### GitServer Class

Handles Git operations and events.

### Event Types

- **push**: Triggered on a push operation.
- **fetch**: Triggered on a fetch operation.
- **tag**: Triggered when a tag is created.
- **head**: Triggered on a HEAD request.
- **info**: Triggered on an info request.

### Authentication

Customizable authentication mechanism to secure repositories.

## Configuration Options

- **autoCreate**: Automatically create repositories if they don't exist.
- **authenticate**: Function to handle authentication logic.

## Event Handling

Examples of handling various events with the `GitServer`:

```typescript
import { GitServer, GitInfo, TagInfo } from './dist/index.js';

const server = new GitServer('/path/to/repositories', {
  autoCreate: true,
  authenticate: async (type, repo, username, password) => {
    // Implement authentication logic
  },
});

server.listen(8080);
console.log('Git server is running on port 8080');

// Handle push events
server.on('push', (info: GitInfo) => {
  console.log(`Push received for repo: ${info.repo}`);
  info.accept();
});

// Handle fetch events
server.on('fetch', (info: GitInfo) => {
  console.log(`Fetch request for repo: ${info.repo}`);
  info.accept();
});

// Handle tag events
server.on('tag', (info: TagInfo) => {
  console.log(`Tag created: ${info.version} in repo: ${info.repo}`);
  info.accept();
});

// Handle head events
server.on('head', (info: GitInfo) => {
  console.log(`HEAD request for repo: ${info.repo}`);
  info.accept();
});

// Handle info events
server.on('info', (info: GitInfo) => {
  console.log(`Info request for repo: ${info.repo}`);
  info.accept();
});

// Handle errors
server.on('error', (error: Error) => {
  console.error(`Error occurred: ${error.message}`);
});
```

## Testing

Run tests using Jest to ensure server functionality:

```bash
yarn test
```

## Contributing

Contributions are welcome. Please read the [contributing guidelines](CONTRIBUTING.md) for more information.

## Community and Support

Join our community on [Discord](https://discord.gg/yourserver) or [GitHub Discussions](https://github.com/yourusername/git-server/discussions).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Acknowledgements

- [node-git-server](https://github.com/gabrielcsapo/node-git-server)
