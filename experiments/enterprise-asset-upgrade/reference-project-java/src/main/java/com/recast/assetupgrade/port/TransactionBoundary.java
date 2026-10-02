package com.recast.assetupgrade.port;

import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

public interface TransactionBoundary {
    <T> CompletableFuture<T> execute(Supplier<CompletableFuture<T>> work);
}
