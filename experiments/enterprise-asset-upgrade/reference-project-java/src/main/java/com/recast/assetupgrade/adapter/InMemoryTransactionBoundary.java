package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.port.TransactionBoundary;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

public final class InMemoryTransactionBoundary implements TransactionBoundary {
    private int transactions;
    private int failures;
    public synchronized int transactionCount() { return transactions; }
    public synchronized int failureCount() { return failures; }
    @Override public synchronized <T> CompletableFuture<T> execute(Supplier<CompletableFuture<T>> work) {
        transactions++;
        try {
            return work.get().whenComplete((result, error) -> { if (error != null) failures++; });
        } catch (RuntimeException error) {
            failures++;
            return CompletableFuture.failedFuture(error);
        }
    }
}
