import CoreGraphics
import Dispatch
import Foundation
import ImageIO

actor HomeArtworkLoader: HomeArtworkLoading {
  private static let defaultCacheCostLimit = 67_108_864
  private static let maximumEncodedBytes = 20_971_520
  private static let minimumDimension = 0.0
  private static let unitScale = 1.0
  private static let minimumPixelSize = 1

  private let resolver: any HomeArtworkResolving
  private let httpClient: HomeArtworkHTTPClient
  private let cacheCostLimit: Int
  private let now: @Sendable () -> Date
  private let memoryPressureEvents: AsyncStream<Void>

  private var authorization: HomeAuthorizationIdentity?
  private var authorizationGeneration: UInt64 = .zero
  private var cache: [CacheKey: CacheEntry] = [:]
  private var cacheCost = Int.zero
  private var accessSequence: UInt64 = .zero
  private var memoryPressureTask: Task<Void, Never>?

  init(
    resolver: any HomeArtworkResolving,
    sessionConfiguration: URLSessionConfiguration = .ephemeral,
    cacheCostLimit: Int = HomeArtworkLoader.defaultCacheCostLimit,
    now: @escaping @Sendable () -> Date = Date.init,
    memoryPressureEvents: AsyncStream<Void> = HomeArtworkMemoryPressure.events()
  ) {
    self.resolver = resolver
    httpClient = HomeArtworkHTTPClient(
      configuration: sessionConfiguration,
      maximumEncodedBytes: Self.maximumEncodedBytes
    )
    self.cacheCostLimit = max(.zero, cacheCostLimit)
    self.now = now
    self.memoryPressureEvents = memoryPressureEvents
  }

  deinit {
    memoryPressureTask?.cancel()
  }

  func authorizationDidChange(to newAuthorization: HomeAuthorizationIdentity) {
    startMemoryPressureMonitoringIfNeeded()
    transition(to: newAuthorization)
  }

  func handleMemoryPressure() {
    removeAllCachedPresentations()
  }

  func image(
    for reference: HomeArtworkReference,
    size: HomeArtworkSizeBucket,
    authorization requestedAuthorization: HomeAuthorizationIdentity
  ) async -> HomeArtworkPresentation? {
    startMemoryPressureMonitoringIfNeeded()
    guard requestCanBegin(authorization: requestedAuthorization) else {
      return nil
    }
    let key = CacheKey(reference: reference.identity, size: size)
    if let presentation = cachedPresentation(for: key) {
      return presentation
    }

    guard now() < requestedAuthorization.accessTokenExpiresAt else {
      return nil
    }
    let generation = authorizationGeneration
    let resolved: HomeArtworkResolvedLocator
    do {
      resolved = try await resolver.resolve(
        reference,
        size: size,
        authorization: requestedAuthorization
      )
    } catch {
      return nil
    }
    guard
      requestIsCurrent(
        authorization: requestedAuthorization,
        generation: generation
      ),
      let locator = ValidatedArtworkLocator(resolved, now: now()),
      locator.canStartFetch(at: now())
    else {
      return nil
    }

    let data: Data
    do {
      data = try await httpClient.fetch(locator)
    } catch {
      return nil
    }
    guard
      requestIsCurrent(
        authorization: requestedAuthorization,
        generation: generation
      ),
      let decoded = Self.decode(data, size: size)
    else {
      return nil
    }
    insert(decoded, for: key)
    return decoded.presentation
  }

  private func requestCanBegin(
    authorization expectedAuthorization: HomeAuthorizationIdentity
  ) -> Bool {
    !Task.isCancelled && authorization == expectedAuthorization
  }

  private func transition(to newAuthorization: HomeAuthorizationIdentity) {
    guard authorization != newAuthorization else {
      return
    }
    authorization = newAuthorization
    authorizationGeneration &+= 1
    removeAllCachedPresentations()
  }

  private func requestIsCurrent(
    authorization expectedAuthorization: HomeAuthorizationIdentity,
    generation: UInt64
  ) -> Bool {
    !Task.isCancelled
      && authorization == expectedAuthorization
      && authorizationGeneration == generation
  }

  private func cachedPresentation(for key: CacheKey) -> HomeArtworkPresentation? {
    guard var entry = cache[key] else {
      return nil
    }
    accessSequence &+= 1
    entry.accessSequence = accessSequence
    cache[key] = entry
    return entry.decoded.presentation
  }

  private func insert(_ decoded: DecodedArtwork, for key: CacheKey) {
    guard decoded.cost <= cacheCostLimit else {
      return
    }
    if let replaced = cache.removeValue(forKey: key) {
      cacheCost -= replaced.decoded.cost
    }
    while cacheCost + decoded.cost > cacheCostLimit,
      let oldest = cache.min(by: { left, right in
        left.value.accessSequence < right.value.accessSequence
      })
    {
      cacheCost -= oldest.value.decoded.cost
      cache.removeValue(forKey: oldest.key)
    }
    accessSequence &+= 1
    cache[key] = CacheEntry(decoded: decoded, accessSequence: accessSequence)
    cacheCost += decoded.cost
  }

  private func removeAllCachedPresentations() {
    cache.removeAll(keepingCapacity: false)
    cacheCost = .zero
  }

  private func startMemoryPressureMonitoringIfNeeded() {
    guard memoryPressureTask == nil else {
      return
    }
    let events = memoryPressureEvents
    memoryPressureTask = Task { [weak self] in
      for await _ in events {
        guard !Task.isCancelled else {
          return
        }
        await self?.handleMemoryPressure()
      }
    }
  }

  private static func decode(_ data: Data, size: HomeArtworkSizeBucket) -> DecodedArtwork? {
    let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
    guard
      let source = CGImageSourceCreateWithData(data as CFData, sourceOptions),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, .zero, nil)
        as? [CFString: Any],
      let pixelWidth = properties[kCGImagePropertyPixelWidth] as? Int,
      let pixelHeight = properties[kCGImagePropertyPixelHeight] as? Int,
      pixelWidth > .zero,
      pixelHeight > .zero
    else {
      return nil
    }
    let sourceWidth = Double(pixelWidth)
    let sourceHeight = Double(pixelHeight)
    let scale = min(
      unitScale,
      Double(size.maxWidth) / sourceWidth,
      Double(size.maxHeight) / sourceHeight
    )
    guard scale > minimumDimension else {
      return nil
    }
    let maximumPixelSize = max(
      minimumPixelSize,
      Int((max(sourceWidth, sourceHeight) * scale).rounded(.down))
    )
    let thumbnailOptions =
      [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
        kCGImageSourceShouldCacheImmediately: true,
      ] as CFDictionary
    guard
      let image = CGImageSourceCreateThumbnailAtIndex(source, .zero, thumbnailOptions)
    else {
      return nil
    }
    let (cost, overflow) = image.bytesPerRow.multipliedReportingOverflow(by: image.height)
    guard !overflow, cost > .zero else {
      return nil
    }
    return DecodedArtwork(
      presentation: HomeArtworkPresentation(image: image),
      cost: cost
    )
  }
}

nonisolated private struct CacheKey: Hashable {
  let reference: HomeArtworkIdentity
  let size: HomeArtworkSizeBucket
}

nonisolated private struct CacheEntry {
  let decoded: DecodedArtwork
  var accessSequence: UInt64
}

nonisolated private struct DecodedArtwork: @unchecked Sendable {
  let presentation: HomeArtworkPresentation
  let cost: Int
}

nonisolated private enum HomeArtworkMemoryPressure {
  static func events() -> AsyncStream<Void> {
    AsyncStream { continuation in
      let source = DispatchSource.makeMemoryPressureSource(
        eventMask: [.warning, .critical],
        queue: .global(qos: .utility)
      )
      source.setEventHandler {
        continuation.yield(())
      }
      continuation.onTermination = { @Sendable _ in
        source.cancel()
      }
      source.resume()
    }
  }
}
