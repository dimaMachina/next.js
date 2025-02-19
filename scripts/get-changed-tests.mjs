// @ts-check
import fs from 'fs/promises'
import execa from 'execa'
import path from 'path'

/**
 * Detects changed tests files by comparing the current branch with `origin/canary`
 * Returns tests separated by test mode (dev/prod), as well as the corresponding commit hash
 * that the current branch is pointing to
 */
export default async function getChangedTests() {
  let eventData = {}

  /** @type import('execa').Options */
  const EXECA_OPTS = { shell: true }
  /** @type import('execa').Options */
  const EXECA_OPTS_STDIO = { ...EXECA_OPTS, stdio: 'inherit' }

  try {
    eventData =
      JSON.parse(
        await fs.readFile(process.env.GITHUB_EVENT_PATH || '', 'utf8')
      )['pull_request'] || {}
  } catch (_) {}

  const branchName =
    eventData?.head?.ref ||
    process.env.GITHUB_REF_NAME ||
    (await execa('git rev-parse --abbrev-ref HEAD', EXECA_OPTS)).stdout

  const remoteUrl =
    eventData?.head?.repo?.full_name ||
    process.env.GITHUB_REPOSITORY ||
    (await execa('git remote get-url origin', EXECA_OPTS)).stdout

  const commitSha =
    eventData?.head?.sha ||
    process.env.GITHUB_SHA ||
    (await execa('git rev-parse HEAD', EXECA_OPTS)).stdout

  const isCanary =
    branchName.trim() === 'canary' && remoteUrl.includes('vercel/next.js')

  if (isCanary) {
    console.log(`Skipping flake detection for canary`)
    return { devTests: [], prodTests: [] }
  }

  try {
    await execa('git remote set-branches --add origin canary', EXECA_OPTS_STDIO)
    await execa('git fetch origin canary --depth=20', EXECA_OPTS_STDIO)
  } catch (err) {
    console.error(await execa('git remote -v', EXECA_OPTS_STDIO))
    console.error(`Failed to fetch origin/canary`, err)
  }

  const changesResult = await execa(
    `git diff origin/canary --name-only`,
    EXECA_OPTS
  ).catch((err) => {
    console.error(err)
    return { stdout: '', stderr: '' }
  })
  console.log(
    {
      branchName,
      remoteUrl,
      isCanary,
      commitSha,
    },
    `\ngit diff:\n${changesResult.stderr}\n${changesResult.stdout}`
  )
  const changedFiles = changesResult.stdout.split('\n')

  // run each test 3 times in each test mode (if E2E) with no-retrying
  // and if any fail it's flakey
  const devTests = []
  const prodTests = []

  for (let file of changedFiles) {
    // normalize slashes
    file = file.replace(/\\/g, '/')
    const fileExists = await fs
      .access(path.join(process.cwd(), file), fs.constants.F_OK)
      .then(() => true)
      .catch(() => false)

    if (fileExists && file.match(/^test\/.*?\.test\.(js|ts|tsx)$/)) {
      if (file.startsWith('test/e2e/')) {
        devTests.push(file)
        prodTests.push(file)
      } else if (file.startsWith('test/prod')) {
        prodTests.push(file)
      } else if (file.startsWith('test/development')) {
        devTests.push(file)
      }
    }
  }

  console.log(
    'Detected tests:',
    JSON.stringify(
      {
        devTests,
        prodTests,
      },
      null,
      2
    )
  )

  return { devTests, prodTests, commitSha }
}
