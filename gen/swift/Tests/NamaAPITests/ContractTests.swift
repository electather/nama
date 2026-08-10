import NamaAPI
import SwiftProtobuf
import XCTest

final class ContractTests: XCTestCase {
  func testCommonContractRoundTrip() throws {
    var header = Nama_Api_V1_HttpHeader()
    header.name = "x-test"
    header.value = "public"

    let encoded = try header.serializedData()
    let decoded = try Nama_Api_V1_HttpHeader(serializedBytes: encoded)
    XCTAssertEqual(decoded, header)

    _ = Google_Rpc_ErrorInfo()
    _ = Google_Rpc_BadRequest()
    _ = Google_Rpc_RequestInfo()
    _ = Google_Rpc_RetryInfo()
  }

  func testOperatorHealthContractRoundTrip() throws {
    var check = Nama_Api_V1_CheckResponse()
    check.status = .serving
    check.serverVersion = "0.1.0"
    check.initialized = true
    check.ready = true
    check.databaseStatus = .serving

    let encodedCheck = try check.serializedData()
    let decodedCheck = try Nama_Api_V1_CheckResponse(serializedBytes: encodedCheck)
    XCTAssertEqual(decodedCheck, check)

    var core = Nama_Api_V1_DiagnosticComponent()
    core.name = "core"
    core.status = .serving
    core.summary = "ready"
    core.checkedAt.seconds = 1

    var database = Nama_Api_V1_DiagnosticComponent()
    database.name = "database"
    database.status = .serving
    database.summary = "connected"
    database.checkedAt.seconds = 2

    var provider = Nama_Api_V1_DiagnosticComponent()
    provider.name = "provider_instance/opaque-id"
    provider.status = .notServing
    provider.summary = "unavailable"
    provider.checkedAt.seconds = 3

    var diagnostics = Nama_Api_V1_GetDiagnosticsResponse()
    diagnostics.serverVersion = "0.1.0"
    diagnostics.requestID = "request-1"
    diagnostics.components = [core, database, provider]

    let encodedDiagnostics = try diagnostics.serializedData()
    let decodedDiagnostics = try Nama_Api_V1_GetDiagnosticsResponse(
      serializedBytes: encodedDiagnostics)
    XCTAssertEqual(decodedDiagnostics, diagnostics)
    XCTAssertEqual(
      decodedDiagnostics.components.map(\.name),
      [
        "core", "database", "provider_instance/opaque-id",
      ])

    _ = Nama_Api_V1_HealthServiceClient.Metadata.Methods.check
    _ = Nama_Api_V1_HealthServiceClient.Metadata.Methods.getDiagnostics
  }
}
