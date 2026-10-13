//! D-13: the single shared operation lock.
//!
//! Before this module, in-flight mutual exclusion was per-service and blind to
//! its peers: `SyncOrchestrator.pipeline_running` (`AtomicBool`) guarded only
//! pipeline-vs-pipeline and `GitService.git_running` only git-vs-git — yet a
//! normal sync (which writes `Engine/Source`) and a Git pull (which writes the
//! same tree) could run concurrently. D-12 raises the rule to **three-way**
//! mutual exclusion (Sync, GitPull, EngineUpdate); D-13 makes it *structural*
//! by routing every entry point through one managed authority.
//!
//! The invariant is carried by the RAII [`OperationGuard`]: acquiring is the
//! only way to enter an operation and the guard's `Drop` is the only way to
//! release it, so a future fourth operation cannot forget to unlock.
//!
//! ## Why `std::sync::Mutex`, not `tokio::sync::Mutex`
//!
//! The guard owns no `MutexGuard`: the critical section inside [`acquire`] and
//! inside `Drop` is a single compare-and-set with **no `.await` inside it**.
//! That lets the guard be *held across the whole operation future* while no
//! lock is held across an `.await` — no async cancellation can strand the slot,
//! and the refusal matrix is testable with plain `#[test]` rather than
//! `#[tokio::test]`. (This is a deliberate, reasoned divergence from
//! RESEARCH Pattern 7's `tokio::sync::Mutex` sketch, which assumed the guard
//! would own the mutex guard.)
//!
//! [`acquire`]: OperationLock::acquire

use crate::error::AppError;
use std::sync::{Arc, Mutex, PoisonError};

/// The operations that are mutually exclusive against one another (D-12).
///
/// `as_str` doubles as the D-14 wire vocabulary, so the enum and the value
/// reported by `get_active_operation` cannot drift apart.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Operation {
    /// The normal sync pipeline — including rollback and single-step retry.
    Sync,
    /// A Git pull of the `UnrealEngine/` checkout.
    GitPull,
    /// The P4 engine update (lands on this lock in plan 30-03).
    EngineUpdate,
}

impl Operation {
    /// The D-14 wire string for this operation.
    pub fn as_str(&self) -> &'static str {
        match self {
            Operation::Sync => "sync",
            Operation::GitPull => "gitPull",
            Operation::EngineUpdate => "engineUpdate",
        }
    }
}

/// The shared authority that enforces D-12's three-way mutual exclusion.
///
/// Managed once by Tauri (`lib.rs`) and injected into every service that owns
/// an entry point. Held only for the duration of an operation.
pub struct OperationLock {
    active: Mutex<Option<Operation>>,
}

impl OperationLock {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }

    /// The operation currently holding the lock, or `None` when idle.
    ///
    /// This is the one answer `get_active_operation` reports (D-14), so the
    /// reported state and the enforced rule share a single source.
    pub fn current(&self) -> Option<Operation> {
        *self.active.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Try to enter `op`, refusing if **any** operation is already held.
    ///
    /// On refusal the slot is left untouched — the running operation is not
    /// cancelled and its own guard still releases it later (no early unlock,
    /// no double-release). The error names the operation currently held (D-12).
    ///
    /// Takes `&Arc<Self>` so the returned guard can own a clone of the lock and
    /// release it from `Drop`.
    pub fn acquire(self: &Arc<Self>, op: Operation) -> Result<OperationGuard, AppError> {
        let mut slot = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(held) = *slot {
            return Err(AppError::Process(format!(
                "A {} operation is already running",
                held.as_str()
            )));
        }
        *slot = Some(op);
        // `slot` is a `std::sync::MutexGuard` but it is dropped here, before
        // the returned guard is handed back — nothing holds it across an await.
        drop(slot);
        Ok(OperationGuard { lock: self.clone() })
    }
}

impl Default for OperationLock {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII release token for [`OperationLock`].
///
/// Not constructible outside this module — obtaining one from
/// [`OperationLock::acquire`] is the only way to enter an operation, and
/// dropping it is the only way to release the slot.
pub struct OperationGuard {
    lock: Arc<OperationLock>,
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        let mut slot = self.lock.active.lock().unwrap_or_else(PoisonError::into_inner);
        *slot = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_OPS: [Operation; 3] = [Operation::Sync, Operation::GitPull, Operation::EngineUpdate];

    #[test]
    fn test_fresh_lock_reports_none_and_acquires_sync() {
        let lock = Arc::new(OperationLock::new());
        assert_eq!(lock.current(), None, "a fresh lock must be idle");
        let guard = lock.acquire(Operation::Sync).expect("first acquire must succeed");
        assert_eq!(lock.current(), Some(Operation::Sync));
        drop(guard);
    }

    #[test]
    fn test_refusal_matrix_covers_all_ordered_pairs() {
        // Held × attempted over all 9 pairs: the 3 self cases are also refused
        // (a second identical operation is not a no-op re-entry).
        for held in ALL_OPS {
            for attempted in ALL_OPS {
                let lock = Arc::new(OperationLock::new());
                let guard = lock
                    .acquire(held)
                    .unwrap_or_else(|e| panic!("acquiring {:?} must succeed: {e}", held));

                let refused = lock.acquire(attempted);
                assert!(
                    refused.is_err(),
                    "{attempted:?} must be refused while {held:?} is held"
                );

                drop(refused);
                drop(guard);
            }
        }
    }

    #[test]
    fn test_refusal_message_names_the_held_operation() {
        for held in ALL_OPS {
            let lock = Arc::new(OperationLock::new());
            let guard = lock.acquire(held).expect("acquire must succeed");

            let err = lock
                .acquire(Operation::Sync)
                .err()
                .expect("must be refused while another op is held");
            let message = err.to_string();
            assert!(
                message.contains(held.as_str()),
                "refusal {message:?} must name the held operation {:?}",
                held.as_str()
            );

            drop(guard);
        }
    }

    #[test]
    fn test_refusal_names_gitpull_while_gitpull_is_held() {
        // Task-2 assertion: a held GitPull is named verbatim in an EngineUpdate
        // refusal (the pre-existing hole D-12 closes — git can no longer run
        // concurrently with another engine-writing operation).
        let lock = Arc::new(OperationLock::new());
        let guard = lock.acquire(Operation::GitPull).expect("acquire must succeed");

        let err = lock
            .acquire(Operation::EngineUpdate)
            .err()
            .expect("EngineUpdate must be refused while GitPull is held");
        assert!(
            err.to_string().contains("gitPull"),
            "refusal {:?} must name gitPull",
            err.to_string()
        );

        drop(guard);
    }

    #[test]
    fn test_drop_releases_slot_and_a_later_acquire_succeeds() {
        let lock = Arc::new(OperationLock::new());
        let guard = lock.acquire(Operation::Sync).expect("acquire must succeed");
        assert_eq!(lock.current(), Some(Operation::Sync));

        drop(guard);
        assert_eq!(lock.current(), None, "dropping the guard must release the slot");

        // No early unlock / no double-release: a fresh acquire works again.
        let again = lock
            .acquire(Operation::EngineUpdate)
            .expect("acquire after release must succeed");
        assert_eq!(lock.current(), Some(Operation::EngineUpdate));
        drop(again);
        assert_eq!(lock.current(), None);
    }

    #[test]
    fn test_refused_acquire_leaves_the_holder_slot_intact() {
        let lock = Arc::new(OperationLock::new());
        let guard = lock.acquire(Operation::Sync).expect("acquire must succeed");

        let refused = lock.acquire(Operation::GitPull);
        assert!(refused.is_err(), "must be refused");
        drop(refused);
        assert_eq!(
            lock.current(),
            Some(Operation::Sync),
            "a refusal must not clear the original holder"
        );

        // The original holder's own release still succeeds afterwards.
        drop(guard);
        assert_eq!(lock.current(), None);
    }

    #[test]
    fn test_operation_as_str_returns_the_d14_wire_strings() {
        assert_eq!(Operation::Sync.as_str(), "sync");
        assert_eq!(Operation::GitPull.as_str(), "gitPull");
        assert_eq!(Operation::EngineUpdate.as_str(), "engineUpdate");
    }
}
