# Deepening — dependency-aware module design

Deepen a cluster of shallow modules safely by classifying its dependencies.
Use the vocabulary in [SKILL.md](SKILL.md): **module**, **interface**,
**seam**, and **adapter**.

## Dependency categories

Classify every dependency of a deepening candidate. Its category determines
how to test the deepened module across its seam.

### 1. In-process

Pure computation and in-memory state with no I/O are always deepenable.
Merge the modules and test directly through the new interface. No adapter is
needed because nothing crosses the process.

### 2. Local-substitutable

Dependencies with local test stand-ins, such as PGLite for Postgres or an
in-memory filesystem, are deepenable when the stand-in exists. Run the
stand-in in the test suite and test the deepened module through its
interface. Keep this seam internal; do not add a port to the module's
external interface.

### 3. Remote-but-owned — ports and adapters

For your own services across a network seam, such as microservices or
internal APIs, define a **port** (interface) at that seam. Let the deep module
own the logic and inject the transport as an **adapter**. Tests use an
in-memory adapter; production uses an HTTP, gRPC, or queue adapter.

Shape the recommendation explicitly: "Define a port at the seam, implement
an HTTP adapter for production and an in-memory adapter for testing, so the
logic sits in one deep module even though it is deployed across a network."
The two adapters make the seam real rather than speculative.

### 4. True-external

For third-party services you do not control, such as Stripe or Twilio, give
the deepened module an injected port for the external dependency. Tests use
a mock adapter, while production uses the real integration adapter.

## Seam discipline

- **One adapter means a hypothetical seam. Two adapters means a real one.**
  Introduce a port when at least two adapters are justified, typically
  production and test. A single-adapter seam adds indirection without
  variation.
- **Separate internal seams from the external seam.** A deep module may have
  internal seams that are private to its implementation and used by its own
  tests. Keep them behind the external interface; tests using an internal
  seam do not make it part of the caller-facing contract.

## Testing strategy — replace, do not layer

- Delete old unit tests on shallow modules once tests at the deepened
  module's interface cover their behaviour. Keeping both test layers makes
  refactors pay twice without defending a second contract.
- Write new tests at the deepened module's interface. The **interface is the
  test surface**.
- Assert observable outcomes through the interface rather than internal
  state.
- Make tests survive internal refactors. A test that changes whenever the
  implementation changes is testing past the interface.
