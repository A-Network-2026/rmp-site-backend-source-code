use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::OnceLock,
    time::{Duration, Instant},
};

use anyhow::Result;
use axum::{
    extract::{Form, Path, Query, State as AxumState},
    http::{
        header::{ACCEPT, CACHE_CONTROL, CONTENT_TYPE, COOKIE, SET_COOKIE, USER_AGENT},
        HeaderMap, HeaderValue, Method, StatusCode,
    },
    response::{Html, IntoResponse, Redirect},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use tokio::time::timeout;
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
};

use crate::{
    db,
    state::{self, AccountView, SharedState},
    transaction::{wallet_seed_matches, TransactionRequest},
};

const EXPLORER_CSS: &str = include_str!("explorer_assets/explorer.css");
const EXPLORER_JS: &str = include_str!("explorer_assets/explorer.js");
const EXPLORER_AUTH_COOKIE: &str = "anet_explorer_wallet";

#[derive(Clone)]
struct RpcContext {
    state: SharedState,
}

#[derive(Clone)]
struct CachedDashboardMetrics {
    metrics: db::DashboardMetrics,
    cached_at: Instant,
}

#[derive(Clone)]
struct CachedNetworkStatsSnapshot {
    snapshot: db::NetworkStatsSnapshot,
    cached_at: Instant,
}

#[derive(Clone)]
struct CachedExplorerCommunitySnapshot {
    snapshot: db::ExplorerCommunitySnapshot,
    cached_at: Instant,
}

#[derive(Clone)]
struct CachedValue<T> {
    value: T,
    cached_at: Instant,
}

static DASHBOARD_METRICS_CACHE: OnceLock<RwLock<Option<CachedDashboardMetrics>>> = OnceLock::new();
static DASHBOARD_METRICS_BACKOFF_UNTIL: OnceLock<RwLock<Option<Instant>>> = OnceLock::new();
static NETWORK_STATS_SNAPSHOT_CACHE: OnceLock<RwLock<Option<CachedNetworkStatsSnapshot>>> =
    OnceLock::new();
static EXPLORER_COMMUNITY_SNAPSHOT_CACHE: OnceLock<
    RwLock<Option<CachedExplorerCommunitySnapshot>>,
> = OnceLock::new();
static TERRITORY_COLONY_USAGE_CACHE: OnceLock<
    RwLock<HashMap<String, CachedValue<Vec<db::ColonyGroupUsageRow>>>>,
> = OnceLock::new();
static TERRITORY_ROOM_PROFILES_CACHE: OnceLock<
    RwLock<HashMap<String, CachedValue<Vec<db::ColonyRoomProfileRow>>>>,
> = OnceLock::new();
static COLONY_ROOM_PROFILES_CACHE: OnceLock<
    RwLock<HashMap<String, CachedValue<Vec<db::ColonyRoomProfileRow>>>>,
> = OnceLock::new();
static ROOM_PROFILE_CACHE: OnceLock<
    RwLock<HashMap<String, CachedValue<Option<db::ColonyRoomProfileRow>>>>,
> = OnceLock::new();
static WEB2_ACCOUNT_CACHE: OnceLock<
    RwLock<HashMap<String, CachedValue<Option<db::Web2AccountRow>>>>,
> = OnceLock::new();

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
}

#[derive(Debug, Serialize)]
struct TransactionAccepted {
    transaction_id: String,
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct Web2AccountResponse {
    address: String,
    sessions: u64,
    ants_balance: u64,
    is_eligible: bool,
}

#[derive(Debug, Serialize)]
struct HybridOnchainView {
    ants_balance: u64,
}

#[derive(Debug, Serialize)]
struct HybridAccountResponse {
    address: String,
    onchain: HybridOnchainView,
    web2: Web2AccountResponse,
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    chain_id: String,
    latest_block_height: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ReadinessResponse {
    status: &'static str,
    postgres: &'static str,
    genesis_accounts: usize,
}

#[derive(Debug, Serialize)]
struct InvestorMetricsResponse {
    chain_id: String,
    activated_supply_ants: u64,
    activated_supply_anet: String,
    latest_block_height: Option<u64>,
    current_epoch_end: String,
    seconds_until_epoch_end: i64,
    metrics: db::DashboardMetrics,
}

#[derive(Debug, Deserialize)]
struct ExplorerSearchQuery {
    q: String,
}

#[derive(Debug, Deserialize, Default)]
struct ExplorerDashboardQuery {
    view: Option<String>,
    from: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ExplorerLoginQuery {
    next: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ExplorerLoginForm {
    wallet: String,
    seed_phrase: String,
    next: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct BlocksQuery {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct DexMintAssetRequest {
    address: String,
    token_symbol: String,
    amount: u64,
    admin_key: String,
}

#[derive(Debug, Deserialize)]
struct AdminMintAnetRequest {
    address: String,
    amount_ants: u64,
    admin_key: String,
}

#[derive(Debug, Serialize)]
struct DexMintAssetResponse {
    address: String,
    token_symbol: String,
    balance: u64,
}

#[derive(Debug, Serialize)]
struct AdminMintAnetResponse {
    address: String,
    ants_balance: u64,
    anet_balance: String,
}

#[derive(Debug, Deserialize)]
struct DexCreatePoolRequest {
    provider: String,
    sender_seed: String,
    token_symbol: String,
    anet_amount_ants: u64,
    token_amount_units: u64,
    fee_bps: Option<u16>,
}

#[derive(Debug, Deserialize)]
struct DexAddLiquidityRequest {
    provider: String,
    sender_seed: String,
    token_symbol: String,
    anet_amount_ants: u64,
    token_amount_units: u64,
}

#[derive(Debug, Deserialize)]
struct DexSwapQuoteRequest {
    token_symbol: String,
    amount_in: u64,
    anet_to_token: bool,
}

#[derive(Debug, Deserialize)]
struct DexSwapExecuteRequest {
    trader: String,
    sender_seed: String,
    token_symbol: String,
    amount_in: u64,
    anet_to_token: bool,
}

pub async fn run_server(state: SharedState, bind_addr: SocketAddr) -> Result<()> {
    let context = RpcContext { state };
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    let router = Router::new()
        .route("/", get(root))
        .route("/robots.txt", get(robots_txt))
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/blocks", get(get_blocks))
        .route("/blocks/:id", get(get_block))
        .route("/blocks/height/:height", get(get_block_by_height))
        .route("/accounts/:address", get(get_account))
        .route("/transactions", post(post_transaction))
        .route("/transaction", post(post_transaction))
        .route("/dex/pools", get(get_dex_pools))
        .route("/dex/pools/:symbol", get(get_dex_pool))
        .route("/dex/assets/mint", post(post_dex_mint_asset))
        .route("/admin/anet/mint", post(post_admin_mint_anet))
        .route("/dex/pools/create", post(post_dex_create_pool))
        .route("/dex/pools/add-liquidity", post(post_dex_add_liquidity))
        .route("/dex/swap/quote", post(post_dex_swap_quote))
        .route("/dex/swap/execute", post(post_dex_swap_execute))
        .route("/web2/account/:address", get(get_web2_account))
        .route("/account/full/:address", get(get_full_account))
        .route("/stats/investor", get(get_investor_metrics))
        .route(
            "/explorer/login",
            get(explorer_login_page).post(explorer_login_submit),
        )
        .route("/explorer/logout", post(explorer_logout))
        .route("/explorer", get(explorer_dashboard))
        .route("/explorer/miners", get(explorer_miners_portal))
        .route("/explorer/build", get(explorer_builder_portal))
        .route("/explorer/assets/explorer.css", get(explorer_stylesheet))
        .route("/explorer/assets/explorer.js", get(explorer_script))
        .route("/explorer/api", get(explorer_api))
        .route("/explorer/health", get(explorer_health))
        .route("/explorer/search", get(explorer_search))
        .route("/explorer/territories/:slug", get(explorer_territory))
        .route("/explorer/colonies/:slug", get(explorer_colony))
        .route("/explorer/rooms/:room_key", get(explorer_room))
        .route("/explorer/blocks", get(explorer_blocks))
        .route("/explorer/blocks/:height", get(explorer_block))
        .route("/explorer/accounts/:address", get(explorer_account))
        .with_state(context)
        .layer(cors)
        .layer(CompressionLayer::new());

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    tracing::info!(address = %bind_addr, "rpc server listening");
    axum::serve(listener, router).await?;
    Ok(())
}

async fn root() -> impl IntoResponse {
    Html("<html><body><meta http-equiv=\"refresh\" content=\"0; url=/explorer\"></body></html>")
}

async fn explorer_stylesheet() -> impl IntoResponse {
    let mut headers = cache_control_header("public, max-age=3600, stale-while-revalidate=86400");
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/css; charset=utf-8"),
    );
    (headers, EXPLORER_CSS).into_response()
}

async fn explorer_script() -> impl IntoResponse {
    let mut headers = cache_control_header("public, max-age=3600, stale-while-revalidate=86400");
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/javascript; charset=utf-8"),
    );
    (headers, EXPLORER_JS).into_response()
}

async fn explorer_login_page(
    Query(query): Query<ExplorerLoginQuery>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let next = sanitize_explorer_next_path(query.next.as_deref());

    if explorer_auth_required() && authenticated_wallet_from_headers(&headers).is_some() {
        return Redirect::to(&next).into_response();
    }

    Html(render_explorer_login_page(None, &next)).into_response()
}

async fn explorer_login_submit(Form(form): Form<ExplorerLoginForm>) -> impl IntoResponse {
    let next = sanitize_explorer_next_path(form.next.as_deref());

    if !explorer_auth_required() {
        return Redirect::to(&next).into_response();
    }

    if explorer_auth_secret().is_none() {
        let body = render_explorer_login_page(
            Some("Explorer auth is enabled but ANET_EXPLORER_AUTH_SECRET is not configured."),
            &next,
        );
        return (StatusCode::SERVICE_UNAVAILABLE, Html(body)).into_response();
    }

    let wallet = form.wallet.trim().to_uppercase();
    if wallet.is_empty() || form.seed_phrase.trim().is_empty() {
        let body = render_explorer_login_page(Some("Wallet and seed phrase are required."), &next);
        return (StatusCode::BAD_REQUEST, Html(body)).into_response();
    }

    if !wallet_seed_matches(&wallet, &form.seed_phrase) {
        let body = render_explorer_login_page(
            Some("Seed phrase does not match the provided ANET wallet."),
            &next,
        );
        return (StatusCode::UNAUTHORIZED, Html(body)).into_response();
    }

    let eligible = if allow_ineligible_wallet_test_mode() {
        true
    } else {
        match load_web2_account_fast(&wallet).await {
            Ok(Some(account)) => account.is_eligible,
            Ok(None) => false,
            Err(_) => {
                let body = render_explorer_login_page(
                    Some("Unable to verify wallet eligibility right now. Please retry."),
                    &next,
                );
                return (StatusCode::SERVICE_UNAVAILABLE, Html(body)).into_response();
            }
        }
    };

    if !eligible {
        let body = render_explorer_login_page(
            Some("This wallet is not eligible yet. Complete at least 1,000 sessions in-app."),
            &next,
        );
        return (StatusCode::FORBIDDEN, Html(body)).into_response();
    }

    let cookie = build_wallet_session_cookie(&wallet);
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        headers.insert(SET_COOKIE, value);
    }

    (headers, Redirect::to(&next)).into_response()
}

async fn explorer_logout() -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    headers.insert(
        SET_COOKIE,
        HeaderValue::from_static(
            "anet_explorer_wallet=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
        ),
    );
    (headers, Redirect::to("/explorer/login?next=%2Fexplorer")).into_response()
}

async fn robots_txt() -> impl IntoResponse {
    (
        cache_control_header("public, max-age=600"),
        "User-agent: *\nDisallow: /explorer/rooms/\n\nUser-agent: MJ12bot\nDisallow: /\n",
    )
}

async fn health(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
) -> impl IntoResponse {
    if request_prefers_html(&headers) {
        return Redirect::to("/explorer/health").into_response();
    }

    let state = context.state.read().await;
    Json(HealthResponse {
        status: "ok",
        chain_id: state.chain_id.clone(),
        latest_block_height: state.blocks.last().map(|block| block.block_height),
    })
    .into_response()
}

async fn ready(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    if request_prefers_html(&headers) {
        return Ok(Redirect::to("/explorer/health").into_response());
    }

    let genesis_accounts = {
        let state = context.state.read().await;
        state.accounts.len()
    };

    if !postgres_ready_fast().await {
        return Err(service_unavailable(format!(
            "service is degraded: postgres unreachable, genesis_accounts_loaded={genesis_accounts}"
        )));
    }

    Ok(Json(ReadinessResponse {
        status: "ready",
        postgres: "ok",
        genesis_accounts,
    })
    .into_response())
}

async fn get_blocks(
    headers: HeaderMap,
    Query(query): Query<BlocksQuery>,
    AxumState(context): AxumState<RpcContext>,
) -> impl IntoResponse {
    if request_prefers_html(&headers) {
        return Redirect::to("/explorer/blocks").into_response();
    }

    let state = context.state.read().await;
    let blocks = match query.limit.filter(|limit| *limit > 0) {
        Some(limit) => {
            let mut blocks = state.latest_blocks(limit.min(128));
            blocks.reverse();
            blocks
        }
        None => state.all_blocks(),
    };

    (
        cache_control_header("public, max-age=2, stale-while-revalidate=8"),
        Json(blocks),
    )
        .into_response()
}

async fn get_block(
    headers: HeaderMap,
    Path(id): Path<String>,
    AxumState(context): AxumState<RpcContext>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    if request_prefers_html(&headers) {
        let state = context.state.read().await;
        let explorer_target = state
            .block_by_id(&id)
            .map(|block| format!("/explorer/blocks/{}", block.block_height));
        drop(state);

        if let Some(explorer_target) = explorer_target {
            return Ok(Redirect::to(&explorer_target).into_response());
        }
    }

    let state = context.state.read().await;
    state
        .block_by_id(&id)
        .map(Json)
        .map(IntoResponse::into_response)
        .ok_or_else(|| not_found(format!("block {id} not found")))
}

async fn get_block_by_height(
    headers: HeaderMap,
    Path(height): Path<u64>,
    AxumState(context): AxumState<RpcContext>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    if request_prefers_html(&headers) {
        return Ok(Redirect::to(&format!("/explorer/blocks/{height}")).into_response());
    }

    let state = context.state.read().await;
    state
        .blocks
        .iter()
        .find(|block| block.block_height == height)
        .cloned()
        .map(Json)
        .map(IntoResponse::into_response)
        .ok_or_else(|| not_found(format!("block {height} not found")))
}

async fn get_account(
    headers: HeaderMap,
    Path(address): Path<String>,
    AxumState(context): AxumState<RpcContext>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    if request_prefers_html(&headers) {
        return Ok(Redirect::to(&format!("/explorer/accounts/{address}")).into_response());
    }

    let state = context.state.read().await;
    state
        .account_view(&address)
        .map(Json)
        .map(IntoResponse::into_response)
        .ok_or_else(|| not_found(format!("account {address} not found")))
}

async fn post_transaction(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
    Json(request): Json<TransactionRequest>,
) -> Result<(StatusCode, Json<TransactionAccepted>), (StatusCode, Json<ApiError>)> {
    if explorer_auth_required() {
        let wallet = authenticated_wallet_from_headers(&headers)
            .ok_or_else(|| unauthorized("wallet login is required".to_owned()))?;
        if request.from.trim().to_uppercase() != wallet {
            return Err(unauthorized(
                "sender wallet must match authenticated wallet session".to_owned(),
            ));
        }
    }

    let transaction = request.into_transaction().map_err(bad_request)?;
    let mut state = context.state.write().await;
    let transaction_id = state.queue_transaction(transaction).map_err(bad_request)?;

    Ok((
        StatusCode::ACCEPTED,
        Json(TransactionAccepted {
            transaction_id,
            status: "queued",
        }),
    ))
}

async fn get_dex_pools(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
) -> impl IntoResponse {
    if request_prefers_html(&headers) {
        return Redirect::to("/explorer/api").into_response();
    }

    let state = context.state.read().await;
    Json(state.dex_pool_list()).into_response()
}

async fn get_dex_pool(
    headers: HeaderMap,
    Path(symbol): Path<String>,
    AxumState(context): AxumState<RpcContext>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    if request_prefers_html(&headers) {
        return Ok(Redirect::to("/explorer/api").into_response());
    }

    let state = context.state.read().await;
    let pool = state
        .dex_pool_view(&symbol)
        .map_err(bad_request)?
        .ok_or_else(|| not_found(format!("pool for {symbol} not found")))?;
    Ok(Json(pool).into_response())
}

async fn post_dex_mint_asset(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
    Json(request): Json<DexMintAssetRequest>,
) -> Result<(StatusCode, Json<DexMintAssetResponse>), (StatusCode, Json<ApiError>)> {
    if request_prefers_html(&headers) {
        return Err(bad_request(anyhow::anyhow!(
            "HTML requests are not supported for this endpoint"
        )));
    }

    let expected_key = std::env::var("ANET_DEX_ADMIN_KEY").unwrap_or_default();
    if expected_key.is_empty() {
        return Err(service_unavailable(
            "ANET_DEX_ADMIN_KEY is not configured".to_owned(),
        ));
    }
    if request.admin_key.trim() != expected_key {
        return Err(unauthorized("invalid admin key".to_owned()));
    }

    let normalized_address = request.address.trim().to_uppercase();
    let mut state = context.state.write().await;
    let balance = state
        .dex_mint_test_asset(&normalized_address, &request.token_symbol, request.amount)
        .map_err(bad_request)?;

    Ok((
        StatusCode::OK,
        Json(DexMintAssetResponse {
            address: normalized_address,
            token_symbol: request.token_symbol.trim().to_ascii_uppercase(),
            balance,
        }),
    ))
}

async fn post_admin_mint_anet(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
    Json(request): Json<AdminMintAnetRequest>,
) -> Result<(StatusCode, Json<AdminMintAnetResponse>), (StatusCode, Json<ApiError>)> {
    if request_prefers_html(&headers) {
        return Err(bad_request(anyhow::anyhow!(
            "HTML requests are not supported for this endpoint"
        )));
    }

    if !anet_test_faucet_enabled() {
        return Err(service_unavailable(
            "ANET_TEST_FAUCET_ENABLED is not enabled".to_owned(),
        ));
    }

    let expected_key = dex_admin_key_required()?;
    if request.admin_key.trim() != expected_key {
        return Err(unauthorized("invalid admin key".to_owned()));
    }

    let normalized_address = request.address.trim().to_uppercase();
    let mut state = context.state.write().await;
    let ants_balance = state
        .admin_credit_anet_test(&normalized_address, request.amount_ants)
        .map_err(bad_request)?;

    Ok((
        StatusCode::OK,
        Json(AdminMintAnetResponse {
            address: normalized_address,
            ants_balance,
            anet_balance: state::format_anet_fixed(ants_balance),
        }),
    ))
}

fn dex_admin_key_required() -> Result<String, (StatusCode, Json<ApiError>)> {
    let expected_key = std::env::var("ANET_DEX_ADMIN_KEY").unwrap_or_default();
    if expected_key.is_empty() {
        return Err(service_unavailable(
            "ANET_DEX_ADMIN_KEY is not configured".to_owned(),
        ));
    }
    Ok(expected_key)
}

fn anet_test_faucet_enabled() -> bool {
    std::env::var("ANET_TEST_FAUCET_ENABLED")
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on"
        })
        .unwrap_or(false)
}

async fn post_dex_create_pool(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
    Json(request): Json<DexCreatePoolRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    if explorer_auth_required() {
        let wallet = authenticated_wallet_from_headers(&headers)
            .ok_or_else(|| unauthorized("wallet login is required".to_owned()))?;
        if request.provider.trim().to_uppercase() != wallet {
            return Err(unauthorized(
                "provider wallet must match authenticated wallet session".to_owned(),
            ));
        }
    }

    if !wallet_seed_matches(&request.provider, &request.sender_seed) {
        return Err(unauthorized(
            "sender seed does not match provider wallet".to_owned(),
        ));
    }

    let mut state = context.state.write().await;
    let result = state
        .dex_create_pool(
            &request.provider,
            &request.token_symbol,
            request.anet_amount_ants,
            request.token_amount_units,
            request.fee_bps,
        )
        .map_err(bad_request)?;

    Ok((StatusCode::CREATED, Json(result)).into_response())
}

async fn post_dex_add_liquidity(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
    Json(request): Json<DexAddLiquidityRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    if explorer_auth_required() {
        let wallet = authenticated_wallet_from_headers(&headers)
            .ok_or_else(|| unauthorized("wallet login is required".to_owned()))?;
        if request.provider.trim().to_uppercase() != wallet {
            return Err(unauthorized(
                "provider wallet must match authenticated wallet session".to_owned(),
            ));
        }
    }

    if !wallet_seed_matches(&request.provider, &request.sender_seed) {
        return Err(unauthorized(
            "sender seed does not match provider wallet".to_owned(),
        ));
    }

    let mut state = context.state.write().await;
    let result = state
        .dex_add_liquidity(
            &request.provider,
            &request.token_symbol,
            request.anet_amount_ants,
            request.token_amount_units,
        )
        .map_err(bad_request)?;

    Ok((StatusCode::OK, Json(result)).into_response())
}

async fn post_dex_swap_quote(
    AxumState(context): AxumState<RpcContext>,
    Json(request): Json<DexSwapQuoteRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let state = context.state.read().await;
    let quote = state
        .dex_quote(
            &request.token_symbol,
            request.amount_in,
            request.anet_to_token,
        )
        .map_err(bad_request)?;

    Ok((StatusCode::OK, Json(quote)).into_response())
}

async fn post_dex_swap_execute(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
    Json(request): Json<DexSwapExecuteRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    if explorer_auth_required() {
        let wallet = authenticated_wallet_from_headers(&headers)
            .ok_or_else(|| unauthorized("wallet login is required".to_owned()))?;
        if request.trader.trim().to_uppercase() != wallet {
            return Err(unauthorized(
                "trader wallet must match authenticated wallet session".to_owned(),
            ));
        }
    }

    if !wallet_seed_matches(&request.trader, &request.sender_seed) {
        return Err(unauthorized(
            "sender seed does not match trader wallet".to_owned(),
        ));
    }

    let mut state = context.state.write().await;
    let result = state
        .dex_swap(
            &request.trader,
            &request.token_symbol,
            request.amount_in,
            request.anet_to_token,
        )
        .map_err(bad_request)?;

    Ok((StatusCode::OK, Json(result)).into_response())
}

async fn get_web2_account(
    Path(address): Path<String>,
) -> Result<Json<Web2AccountResponse>, (StatusCode, Json<ApiError>)> {
    let account = load_web2_account_fast(&address).await?;

    account
        .map(|account| {
            Json(Web2AccountResponse {
                address: account.address,
                sessions: account.sessions,
                ants_balance: account.ants_balance,
                is_eligible: account.is_eligible,
            })
        })
        .ok_or_else(|| not_found(format!("Ant Ledger account {address} not found")))
}

async fn get_full_account(
    Path(address): Path<String>,
    AxumState(context): AxumState<RpcContext>,
) -> Result<Json<HybridAccountResponse>, (StatusCode, Json<ApiError>)> {
    let onchain = {
        let state = context.state.read().await;
        state.account_view(&address)
    };

    let web2 = load_web2_account_fast(&address).await?;

    match (onchain, web2) {
        (Some(onchain), Some(web2)) => Ok(Json(HybridAccountResponse {
            address: address.clone(),
            onchain: HybridOnchainView {
                ants_balance: onchain.ants_balance,
            },
            web2: Web2AccountResponse {
                address: web2.address,
                sessions: web2.sessions,
                ants_balance: web2.ants_balance,
                is_eligible: web2.is_eligible,
            },
            status: "ACTIVATED",
        })),
        (None, Some(web2)) => Ok(Json(HybridAccountResponse {
            address: address.clone(),
            onchain: HybridOnchainView { ants_balance: 0 },
            web2: Web2AccountResponse {
                address: web2.address,
                sessions: web2.sessions,
                ants_balance: web2.ants_balance,
                is_eligible: web2.is_eligible,
            },
            status: "NOT_ACTIVATED",
        })),
        (Some(onchain), None) => Ok(Json(HybridAccountResponse {
            address: address.clone(),
            onchain: HybridOnchainView {
                ants_balance: onchain.ants_balance,
            },
            web2: Web2AccountResponse {
                address,
                sessions: 0,
                ants_balance: 0,
                is_eligible: false,
            },
            status: "ACTIVATED",
        })),
        (None, None) => Err(not_found("account not found".to_owned())),
    }
}

async fn get_investor_metrics(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    if request_prefers_html(&headers) {
        return Ok(Redirect::to("/explorer/api").into_response());
    }

    let summary = {
        let state = context.state.read().await;
        state.network_summary()
    };

    let metrics = load_dashboard_metrics_fast().await?;

    Ok((
        cache_control_header("public, max-age=5, stale-while-revalidate=15"),
        Json(InvestorMetricsResponse {
            chain_id: summary.chain_id,
            activated_supply_ants: summary.total_ants,
            activated_supply_anet: summary.total_anet,
            latest_block_height: summary.latest_block_height,
            current_epoch_end: summary.current_epoch_end.to_rfc3339(),
            seconds_until_epoch_end: summary.seconds_until_epoch_end,
            metrics,
        }),
    )
        .into_response())
}

async fn explorer_dashboard(
    headers: HeaderMap,
    Query(query): Query<ExplorerDashboardQuery>,
    AxumState(context): AxumState<RpcContext>,
) -> impl IntoResponse {
    if explorer_auth_required() && authenticated_wallet_from_headers(&headers).is_none() {
        return Redirect::to("/explorer/login?next=%2Fexplorer").into_response();
    }

    let (summary, latest_blocks) = {
        let state = context.state.read().await;
        (state.network_summary(), state.latest_blocks(8))
    };

    let transfer_only = query.view.as_deref() == Some("transfer");

    let (dashboard_metrics, fallback_network_stats, fallback_community_snapshot) = if transfer_only
    {
        (None, None, None)
    } else {
        let (metrics, snapshot, community) = tokio::join!(
            try_load_dashboard_metrics_fast(),
            try_load_network_stats_snapshot_fast(),
            try_load_explorer_community_snapshot_fast()
        );
        let snapshot = if metrics.is_some() { None } else { snapshot };
        let community = if metrics.is_some() { None } else { community };
        (metrics, snapshot, community)
    };

    let blocks_html = if latest_blocks.is_empty() {
        "<p class=\"muted\">No blocks have been created yet.</p>".to_owned()
    } else {
        latest_blocks
            .iter()
            .map(|block| {
                format!(
                    "<a class=\"list-row\" href=\"/explorer/blocks/{height}\"><span>Block #{height}</span><span>{tx_count} tx</span><span>{fees} ANTS fees</span></a>",
                    height = block.block_height,
                    tx_count = format_integer(block.transactions.len() as u64),
                    fees = format_integer(block.total_fees_ants),
                )
            })
            .collect::<Vec<_>>()
            .join("")
    };

    let hero_metrics_html = if let Some(metrics) = dashboard_metrics.as_ref() {
        let worldwide_workers = format!(
            "{} real miners in {} countries",
            format_integer(metrics.total_real_miners),
            format_integer(metrics.country_count)
        );
        format!(
            r#"
        <div>
            <span>Accumulated Work</span>
            <strong>{accumulated_anet} ANET</strong>
        </div>
        <div>
            <span>Worldwide Workers</span>
            <strong>{worldwide_workers}</strong>
        </div>
        <div>
            <span>Sessions To Halving</span>
            <strong>{sessions_left}</strong>
        </div>
        <div>
            <span>Colony Groups In Use</span>
            <strong>{group_participants} ants across {group_rooms} rooms</strong>
        </div>
"#,
            accumulated_anet = state::format_anet_fixed(metrics.total_accumulated_ants),
            worldwide_workers = worldwide_workers,
            sessions_left = format_integer(metrics.remaining_sessions_to_halving),
            group_participants = format_integer(metrics.total_group_participants),
            group_rooms = format_integer(metrics.total_colony_rooms),
        )
    } else {
        format!(
            r#"
        <div>
            <span>Transfer Cadence</span>
            <strong>{epoch_label}</strong>
        </div>
        <div>
            <span>Activated Supply</span>
            <strong>{total_anet} ANET</strong>
        </div>
        <div>
            <span>Current Window</span>
            <strong>{countdown}</strong>
        </div>
        <div>
            <span>Epoch End</span>
            <strong class=\"break-anywhere\">{epoch_end}</strong>
        </div>
"#,
            epoch_label = format_transfer_epoch_label(summary.epoch_seconds),
            total_anet = summary.total_anet,
            countdown = seconds_to_countdown(summary.seconds_until_epoch_end),
            epoch_end = summary.current_epoch_end.to_rfc3339(),
        )
    };

    let investor_cards_html = if let Some(metrics) = dashboard_metrics.as_ref() {
        let supply_delta_ants = summary.total_ants.abs_diff(metrics.total_accumulated_ants);

        format!(
            r#"
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Production Accumulated Output</div>
        <p class="metric metric-finance"><span class="metric-amount">{accumulated_anet}</span><span class="metric-unit">ANET</span></p>
        <p class="metric-sub mono">{accumulated_ants} ANTS</p>
        <p class="metric-note">Production-database total mined or worked output across the colony economy.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Confirmed Layer 1 Supply</div>
        <p class="metric metric-finance"><span class="metric-amount">{activated_anet}</span><span class="metric-unit">ANET</span></p>
        <p class="metric-sub mono">{activated_ants} ANTS</p>
        <p class="metric-note">Already settled into the live Layer 1 ledger and reflected in wallet balances.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Source Reconciliation Delta</div>
        <p class="metric metric-finance"><span class="metric-amount">{delta_anet}</span><span class="metric-unit">ANET</span></p>
        <p class="metric-sub mono">{delta_ants} ANTS</p>
        <p class="metric-note">Current difference between production accumulated output and confirmed Layer 1 supply.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Worldwide Worker Base</div>
        <p class="metric mono">{real_miners}</p>
        <p class="metric-note">Real miners with completed sessions. {verified_workers} verified workers across {countries} countries.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Live Mining Activity</div>
        <p class="metric mono">{active_miners}</p>
        <p class="metric-note">Workers mining now. {online_users} ants online and {eligible_users} workers already halving-eligible.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Sessions To Next Halving</div>
        <p class="metric mono">{sessions_left}</p>
        <p class="metric-note">Stage {stage}/{max_stage}. {progress}% through the current {halving_interval}-session interval.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Colony Group Adoption</div>
        <p class="metric mono">{group_participants}</p>
        <p class="metric-note">Ants active in colony group chat. {group_rooms} rooms and {group_messages} messages tracked live.</p>
    </article>
"#,
            accumulated_anet = format_anet_display(metrics.total_accumulated_ants),
            accumulated_ants = format_integer(metrics.total_accumulated_ants),
            activated_anet = format_anet_display(summary.total_ants),
            activated_ants = format_integer(summary.total_ants),
            delta_anet = format_anet_display(supply_delta_ants),
            delta_ants = format_integer(supply_delta_ants),
            real_miners = format_integer(metrics.total_real_miners),
            verified_workers = format_integer(metrics.total_workers),
            countries = format_integer(metrics.country_count),
            active_miners = format_integer(metrics.total_active_miners),
            online_users = format_integer(metrics.users_online),
            eligible_users = format_integer(metrics.total_eligible_users),
            sessions_left = format_integer(metrics.remaining_sessions_to_halving),
            stage = format_integer(metrics.halving_stage),
            max_stage = format_integer(metrics.max_halving_stage),
            progress = format_percent(metrics.next_halving_progress),
            halving_interval = format_integer(metrics.halving_interval),
            group_participants = format_integer(metrics.total_group_participants),
            group_rooms = format_integer(metrics.total_colony_rooms),
            group_messages = format_integer(metrics.total_group_messages),
        )
    } else {
        let supply_note = if summary.used_supply_history_fallback {
            "Already settled into the Layer 1 activated ledger. Source: chain-history fallback while live account sync is rebuilding."
        } else {
            "Already settled into the Layer 1 activated ledger."
        };

        let validator_note = if summary.used_validator_history_fallback {
            "Validator count is currently shown from the latest finalized block miner set while live validator sync is unavailable."
        } else {
            "Eligible worker validators currently recognized by the colony state."
        };

        let latest_block_card = summary
            .latest_block_height
            .map(|height| {
                format!(
                    r#"<a class="card stat-card-pro spotlight-card card-link" href="/explorer/blocks/{height}">
        <div class="detail-kicker">Latest Block</div>
        <p class="metric mono">#{height}</p>
        <p class="metric-note">Most recent finalized settlement block on the activated ledger.</p>
    </a>"#,
                )
            })
            .unwrap_or_else(|| {
                r#"<article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Latest Block</div>
        <p class="metric mono">Pending</p>
        <p class="metric-note">No settlement block has been finalized yet.</p>
    </article>"#
                    .to_owned()
            });

        format!(
            r#"
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Activated On-Chain Supply</div>
        <p class="metric metric-finance"><span class="metric-amount">{activated_anet}</span><span class="metric-unit">ANET</span></p>
        <p class="metric-sub mono">{activated_ants} ANTS</p>
        <p class="metric-note">{supply_note}</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Active Validators</div>
        <p class="metric mono">{active_miners}</p>
        <p class="metric-note">{validator_note}</p>
    </article>
    {latest_block_card}
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Current Window Ends</div>
        <p class="metric mono" id="countdown" data-seconds="{seconds}">{countdown}</p>
        <p class="metric-note break-anywhere">This settlement window closes at {epoch_end}. A block is created only when transfers or newly synchronized ANTS supply exist.</p>
    </article>
"#,
            activated_anet = format_anet_display(summary.total_ants),
            activated_ants = format_integer(summary.total_ants),
            supply_note = supply_note,
            active_miners = format_integer(summary.active_miners as u64),
            validator_note = validator_note,
            latest_block_card = latest_block_card,
            seconds = summary.seconds_until_epoch_end,
            countdown = seconds_to_countdown(summary.seconds_until_epoch_end),
            epoch_end = summary.current_epoch_end.to_rfc3339(),
        )
    };

    let executive_panel_html = if let Some(metrics) = dashboard_metrics.as_ref() {
        let supply_delta_ants = summary.total_ants.abs_diff(metrics.total_accumulated_ants);
        let supply_delta_anet = format_anet_display(supply_delta_ants);
        let supply_delta_direction = if summary.total_ants >= metrics.total_accumulated_ants {
            "Layer 1 is ahead of the production accumulation feed"
        } else {
            "Production accumulation feed is ahead of Layer 1"
        };
        let activated_share = percentage(summary.total_ants, metrics.total_accumulated_ants.max(1));
        let claimed_share = percentage(
            metrics.total_anet_claimed_ants,
            metrics.total_accumulated_ants.max(1),
        );
        let worker_activity_share =
            percentage(metrics.total_active_miners, metrics.total_workers.max(1));

        format!(
            r#"
<section class="executive-band">
    <article class="card executive-card">
        <p class="eyebrow">Executive Supply View</p>
        <h2>Capital Visibility</h2>
        <p class="muted">A fast reading layer for investors covering production-db accumulation, confirmed Layer 1 supply, claimed value, and the live worker engine behind the colony.</p>
        <div class="executive-grid">
            <div><span>Source Delta</span><strong class="mono">{supply_delta_anet} ANET</strong></div>
            <div><span>Delta Direction</span><strong>{supply_delta_direction}</strong></div>
        </div>
        <div class="executive-stack">
            <div class="executive-meter">
                <div class="executive-head"><strong>Confirmed Layer 1 vs production accumulation</strong><span>{activated_share}</span></div>
                <div class="progress-track executive-track"><span style="width: {activated_share};"></span></div>
            </div>
            <div class="executive-meter">
                <div class="executive-head"><strong>Claimed vs accumulated output</strong><span>{claimed_share}</span></div>
                <div class="progress-track executive-track"><span style="width: {claimed_share};"></span></div>
            </div>
            <div class="executive-meter">
                <div class="executive-head"><strong>Live worker activity</strong><span>{worker_activity_share}</span></div>
                <div class="progress-track executive-track"><span style="width: {worker_activity_share};"></span></div>
            </div>
        </div>
    </article>
    <article class="card executive-card executive-chart-card">
        <p class="eyebrow">Colony Engine</p>
        <h2>Executive Signal Board</h2>
        <div class="executive-grid">
            <div><span>Real Miners</span><strong class="mono">{real_miners}</strong></div>
            <div><span>Online Now</span><strong class="mono">{users_online}</strong></div>
            <div><span>Countries</span><strong class="mono">{countries}</strong></div>
            <div><span>Colony Groups</span><strong class="mono">{group_rooms}</strong></div>
        </div>
        <div class="hero-tags executive-tags">
            <a class="pill pill-link" href="/stats/investor">Investor Metrics API</a>
            <a class="pill pill-link" href="/explorer/colonies/{worker_slug}">Worker Colony Drilldown</a>
        </div>
    </article>
</section>
"#,
            supply_delta_anet = supply_delta_anet,
            supply_delta_direction = supply_delta_direction,
            activated_share = format_percent(activated_share),
            claimed_share = format_percent(claimed_share),
            worker_activity_share = format_percent(worker_activity_share),
            real_miners = format_integer(metrics.total_real_miners),
            users_online = format_integer(metrics.users_online),
            countries = format_integer(metrics.country_count),
            group_rooms = format_integer(metrics.total_colony_rooms),
            worker_slug = colony_slug("Worker Ants"),
        )
    } else {
        String::new()
    };

    let render_country_rows_html = |top_countries: &[db::DashboardCountryRow]| {
        if top_countries.is_empty() {
            return "<p class=\"muted\">Worldwide worker distribution is not available yet.</p>"
                .to_owned();
        }

        let max_workers = top_countries
            .iter()
            .map(|row| row.workers)
            .max()
            .unwrap_or(1);

        top_countries
            .iter()
            .map(|row| {
                let width = if max_workers == 0 {
                    0.0
                } else {
                    ((row.workers as f64 / max_workers as f64) * 100.0).max(8.0)
                };

                format!(
                    r#"
        <a class="country-row link-card" href="/explorer/territories/{slug}">
            <div class="country-meta">
                <strong>{country}</strong>
                <span>{workers} workers</span>
            </div>
            <div class="country-bar"><span style="width: {width:.2}%;"></span></div>
        </a>
"#,
                    slug = territory_slug(&row.country),
                    country = row.country,
                    workers = format_integer(row.workers),
                    width = width,
                )
            })
            .collect::<Vec<_>>()
            .join("")
    };

    let render_group_cards_html = |group_usage: &[db::ColonyGroupUsageRow]| {
        let preferred_groups = [
            "Worker Ants",
            "Queen Ant",
            "Nurse Ants",
            "Farmer Ants",
            "Builder Ants",
            "Scout Ants",
            "Soldier Ants",
        ];

        let mut group_cards = preferred_groups
            .iter()
            .map(|label| {
                let usage = group_usage.iter().find(|row| row.room_name == *label);
                let room_count = usage.map(|row| row.room_count).unwrap_or(0);
                let active_chat_ants = usage.map(|row| row.active_chat_ants).unwrap_or(0);
                let message_count = usage.map(|row| row.message_count).unwrap_or(0);
                let top_owner_label = usage
                    .map(|row| row.top_owner_label.as_str())
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or("No owner yet");

                format!(
                    r#"
        <a class="group-card link-card" href="/explorer/colonies/{slug}">
            <p class="eyebrow">Colony Label</p>
            <h3>{label}</h3>
            <div class="group-meta">
                <div><span>Rooms</span><strong class="mono">{room_count}</strong></div>
                <div><span>Active Ants</span><strong class="mono">{active_chat_ants}</strong></div>
                <div><span>Messages</span><strong class="mono">{message_count}</strong></div>
                <div><span>Top Owner</span><strong>{top_owner_label}</strong></div>
            </div>
        </a>
"#,
                    slug = colony_slug(label),
                    label = label,
                    room_count = format_integer(room_count),
                    active_chat_ants = format_integer(active_chat_ants),
                    message_count = format_integer(message_count),
                    top_owner_label = escape_html(top_owner_label),
                )
            })
            .collect::<Vec<_>>();

        group_cards.extend(
            group_usage
                .iter()
                .filter(|row| !preferred_groups.contains(&row.room_name.as_str()))
                .map(|row| {
                    format!(
                        r#"
        <a class="group-card link-card" href="/explorer/colonies/{slug}">
            <p class="eyebrow">Colony Label</p>
            <h3>{label}</h3>
            <div class="group-meta">
                <div><span>Rooms</span><strong class="mono">{room_count}</strong></div>
                <div><span>Active Ants</span><strong class="mono">{active_chat_ants}</strong></div>
                <div><span>Messages</span><strong class="mono">{message_count}</strong></div>
                <div><span>Top Owner</span><strong>{top_owner_label}</strong></div>
            </div>
        </a>
"#,
                        slug = colony_slug(&row.room_name),
                        label = row.room_name,
                        room_count = format_integer(row.room_count),
                        active_chat_ants = format_integer(row.active_chat_ants),
                        message_count = format_integer(row.message_count),
                        top_owner_label = escape_html(&row.top_owner_label),
                    )
                }),
        );

        group_cards.join("")
    };

    let strategic_sections_html = if let Some(metrics) = dashboard_metrics.as_ref() {
        let country_rows_html = render_country_rows_html(&metrics.top_countries);
        let group_cards_html = render_group_cards_html(&metrics.group_usage);

        format!(
            r#"
<section class="card section-surface">
    <div class="section-head">
        <div>
            <p class="eyebrow">Investor Snapshot</p>
            <h2>Supply, Halving, and Worker Economics</h2>
        </div>
        <span class="muted">Live production metrics tied to accumulated ANTS, verified worker activity, and the total-session halving schedule.</span>
    </div>
    <div class="progress-shell">
        <div class="progress-head">
            <strong>Next halving readiness</strong>
            <span>{progress}% of the active interval completed</span>
        </div>
        <div class="progress-track"><span style="width: {progress_width};"></span></div>
    </div>
    <div class="details details-strong signal-grid">
        <div>
            <span>Total ANET Claimed</span>
            <strong class="mono">{claimed_anet} ANET</strong>
        </div>
        <div>
            <span>Current Reward / Session</span>
            <strong class="mono">{current_reward} ANET</strong>
        </div>
        <div>
            <span>Next Reward / Session</span>
            <strong class="mono">{next_reward} ANET</strong>
        </div>
        <div>
            <span>Registered Accounts</span>
            <strong class="mono">{registered_accounts}</strong>
        </div>
        <div>
            <span>Total Work Sessions</span>
            <strong class="mono">{total_sessions}</strong>
        </div>
        <div>
            <span>Converted Workers</span>
            <strong class="mono">{converted_workers}</strong>
        </div>
        <div>
            <span>Mining Status</span>
            <strong>{mining_status}</strong>
        </div>
    </div>
</section>
<section class="grid grid-two">
    <article class="card section-surface">
        <div class="section-head">
            <div>
                <p class="eyebrow">ANT Territories</p>
                <h2>All ANT Territories</h2>
            </div>
            <span class="muted">Verified worker ants grouped across every active ANT Territory in the network.</span>
        </div>
        <div class="country-list">{country_rows_html}</div>
    </article>
    <article class="card section-surface">
        <div class="section-head">
            <div>
                <p class="eyebrow">Colony Chat</p>
                <h2>Group Label Adoption</h2>
            </div>
            <span class="muted">Live count of how many ants are using each in-app colony group label. Click a colony card for its dedicated drilldown.</span>
        </div>
        <div class="group-grid">{group_cards_html}</div>
    </article>
</section>
"#,
            progress = format_percent(metrics.next_halving_progress),
            progress_width = format_percent(metrics.next_halving_progress),
            claimed_anet = state::format_anet_fixed(metrics.total_anet_claimed_ants),
            current_reward = state::format_anet_fixed(metrics.current_reward_per_session_ants),
            next_reward = state::format_anet_fixed(metrics.next_reward_per_session_ants),
            registered_accounts = format_integer(metrics.total_registered_accounts),
            total_sessions = format_integer(metrics.total_sessions),
            converted_workers = format_integer(metrics.total_converted_users),
            mining_status = if metrics.is_mining_active {
                "Mining Active"
            } else {
                "Mining Paused"
            },
            country_rows_html = country_rows_html,
            group_cards_html = group_cards_html,
        )
    } else if let Some(snapshot) = fallback_community_snapshot.as_ref() {
        let country_rows_html = render_country_rows_html(&snapshot.top_countries);
        let group_cards_html = render_group_cards_html(&snapshot.group_usage);

        format!(
            r#"
<section class="card section-surface">
    <div class="section-head">
        <div>
            <p class="eyebrow">Investor Snapshot</p>
            <h2>Extended production metrics are temporarily unavailable</h2>
        </div>
        <span class="muted">The explorer is live, but heavy Web2 analytics timed out. Territory and colony views below are served from a lightweight snapshot.</span>
    </div>
</section>
<section class="grid grid-two">
    <article class="card section-surface">
        <div class="section-head">
            <div>
                <p class="eyebrow">ANT Territories</p>
                <h2>All ANT Territories</h2>
            </div>
            <span class="muted">{countries} indexed territories from lightweight worker-distribution reads.</span>
        </div>
        <div class="country-list">{country_rows_html}</div>
    </article>
    <article class="card section-surface">
        <div class="section-head">
            <div>
                <p class="eyebrow">Colony Chat</p>
                <h2>Group Label Adoption</h2>
            </div>
            <span class="muted">{rooms} colony rooms, {participants} active ants, and {messages} tracked messages from lightweight chat aggregation.</span>
        </div>
        <div class="group-grid">{group_cards_html}</div>
    </article>
</section>
"#,
            countries = format_integer(snapshot.country_count),
            rooms = format_integer(snapshot.total_colony_rooms),
            participants = format_integer(snapshot.total_group_participants),
            messages = format_integer(snapshot.total_group_messages),
            country_rows_html = country_rows_html,
            group_cards_html = group_cards_html,
        )
    } else {
        r#"
<section class="card section-surface">
    <div class="section-head">
        <div>
            <p class="eyebrow">Investor Snapshot</p>
            <h2>Extended production metrics are temporarily unavailable</h2>
        </div>
        <span class="muted">The explorer is live, but the additional Web2 worker analytics source is not currently reachable from this node.</span>
    </div>
</section>
<section class="grid grid-two">
    <article class="card section-surface">
        <div class="section-head">
            <div>
                <p class="eyebrow">ANT Territories</p>
                <h2>All ANT Territories</h2>
            </div>
            <span class="muted">Territory analytics are warming up. Reload in a moment or increase dashboard timeout settings.</span>
        </div>
        <div class="country-list"><p class="muted">No territory snapshot available yet.</p></div>
    </article>
    <article class="card section-surface">
        <div class="section-head">
            <div>
                <p class="eyebrow">Colony Chat</p>
                <h2>Group Label Adoption</h2>
            </div>
            <span class="muted">Colony analytics are warming up. Reload in a moment or increase community snapshot timeout.</span>
        </div>
        <div class="group-grid"><p class="muted">No colony snapshot available yet.</p></div>
    </article>
</section>
"#
        .to_owned()
    };

    let block_trigger_reason = if summary.mempool_depth > 0 {
        format!(
            "Mempool has {} queued transfer(s)",
            format_integer(summary.mempool_depth)
        )
    } else if summary.pending_activated_supply_ants > 0 {
        format!(
            "Pending activated Web2 supply delta: {} ANTS",
            format_integer(summary.pending_activated_supply_ants)
        )
    } else {
        "No pending transfer or activation delta; next block waits for fresh work".to_owned()
    };

    let last_sync_label = summary
        .last_web2_sync_at
        .map(|timestamp| timestamp.to_rfc3339())
        .unwrap_or_else(|| "No successful Web2 sync recorded yet".to_owned());

    let sync_health_label = match summary.last_web2_sync_error.as_ref() {
        Some(error) => format!("Degraded: {}", escape_html(error)),
        None => "Healthy".to_owned(),
    };

    let global_user_mined_label = dashboard_metrics
        .as_ref()
        .map(|metrics| {
            format!(
                "{} ANET ({} ANTS)",
                format_anet_display(metrics.total_accumulated_ants),
                format_integer(metrics.total_accumulated_ants)
            )
        })
        .or_else(|| {
            fallback_network_stats.as_ref().map(|snapshot| {
                format!(
                    "{} ANET ({} ANTS) [lightweight fallback]",
                    format_anet_display(snapshot.total_accumulated_ants),
                    format_integer(snapshot.total_accumulated_ants)
                )
            })
        })
        .unwrap_or_else(|| {
            format!(
                "At least {} ANET ({} ANTS) [on-chain confirmed floor; Web2 metrics offline]",
                format_anet_display(summary.total_ants),
                format_integer(summary.total_ants)
            )
        });

    let activated_on_chain_label = format!(
        "{} ANET ({} ANTS)",
        format_anet_display(summary.total_ants),
        format_integer(summary.total_ants)
    );

    let pending_activation_delta_label = format!(
        "{} ANET ({} ANTS)",
        format_anet_display(summary.pending_activated_supply_ants),
        format_integer(summary.pending_activated_supply_ants)
    );

    let block_diagnostics_html = format!(
        r#"
<section class="card section-surface">
    <div class="section-head">
        <div>
            <p class="eyebrow">Block Trigger Diagnostics</p>
            <h2>Why the next block will or will not be created</h2>
        </div>
        <span class="muted">This panel explains live consensus trigger state so operators can distinguish idle epochs from sync-related degradation.</span>
    </div>
    <div class="details details-strong" style="margin-bottom: 16px;">
        <div>
            <span>Global User Mined</span>
            <strong class="mono break-anywhere">{global_user_mined}</strong>
        </div>
        <div>
            <span>Activated On-Chain</span>
            <strong class="mono break-anywhere">{activated_on_chain}</strong>
        </div>
        <div>
            <span>Pending Activation Delta</span>
            <strong class="mono break-anywhere">{pending_activation_delta}</strong>
        </div>
    </div>
    <div class="details details-strong signal-grid">
        <div>
            <span>Pending Block Work</span>
            <strong>{pending_work}</strong>
        </div>
        <div>
            <span>Trigger Reason</span>
            <strong>{trigger_reason}</strong>
        </div>
        <div>
            <span>Mempool Transfers</span>
            <strong class="mono">{mempool_depth}</strong>
        </div>
        <div>
            <span>Pending Activated Supply</span>
            <strong class="mono">{pending_activation} ANTS</strong>
        </div>
        <div>
            <span>Last Successful Web2 Sync</span>
            <strong class="mono break-anywhere">{last_sync}</strong>
        </div>
        <div>
            <span>Web2 Sync Health</span>
            <strong class="break-anywhere">{sync_health}</strong>
        </div>
    </div>
</section>
"#,
        global_user_mined = escape_html(&global_user_mined_label),
        activated_on_chain = activated_on_chain_label,
        pending_activation_delta = pending_activation_delta_label,
        pending_work = yes_no(summary.has_pending_block_work),
        trigger_reason = escape_html(&block_trigger_reason),
        mempool_depth = format_integer(summary.mempool_depth),
        pending_activation = format_integer(summary.pending_activated_supply_ants),
        last_sync = escape_html(&last_sync_label),
        sync_health = sync_health_label,
    );

    let transfer_panel_html = r#"
<section class="card section-surface">
    <div class="section-head"><div><p class="eyebrow">Worker Transfer</p><h2>Transfer</h2></div><span class="muted">Submit a private-mainnet transfer to the mempool for inclusion in the next fast transfer block. This form uses ANET for user input, while the chain stores exact values in ANTS where 100,000,000 ANTS = 1 ANET.</span></div>
    <div class="details details-strong" style="margin-bottom: 18px;">
        <div><span>Input Unit</span><strong class="mono">ANET</strong></div>
        <div><span>Chain Unit</span><strong class="mono">ANTS</strong></div>
        <div><span>Conversion</span><strong class="mono">1 ANET = 100,000,000 ANTS</strong></div>
        <div><span>Eligibility Rule</span><strong>Both wallets need at least 1,000 Web2 sessions</strong></div>
    </div>
    <form id="tx-form" class="tx-form">
        <label><span>From Wallet</span><input id="tx-from" placeholder="ANET..." required /></label>
        <label><span>To Wallet</span><input id="tx-to" placeholder="ANET..." required /></label>
        <label><span>Amount (ANET)</span><input id="tx-amount" type="number" min="0.00000001" step="0.00000001" placeholder="0.04882812" required /></label>
        <label><span>Fee (ANET)</span><input id="tx-fee" type="number" min="0.00001" step="0.00000001" value="0.00001" required /><span class="field-hint">Minimum fee: 0.00001 ANET (1,000 ANTS)</span></label>
        <label><span>Memo (Optional)</span><input id="tx-memo" maxlength="160" placeholder="What this transfer is for" /></label>
        <label><span>Sender Seed Phrase</span><input id="tx-seed" type="password" placeholder="12-word wallet seed" required /></label>
        <button type="submit">Queue Transaction</button>
    </form>
    <div id="tx-result" class="tx-result muted">Enter values in ANET. The explorer converts them into exact integer ANTS before submission so the chain can record the transfer precisely. Transactions remain in the mempool until the next TPoW transfer block is created.</div>
</section>
<script src="/explorer/assets/explorer.js" defer></script>
"#.to_owned();

    if transfer_only {
        let prefilled_wallet = query.from.as_deref().unwrap_or("");
        let transfer_only_body = format!(
            r#"
<section class="hero compact-hero">
    <p class="eyebrow">Worker Transfer</p>
    <h1>Transfer</h1>
    <p class="hero-sub muted">This dApp browser view is focused only on the live Layer 1 worker transfer form so users can move directly into transaction submission without the full dashboard.</p>
    <div class="hero-tags">
        <span class="pill">TPoW Consensus</span>
        <span class="pill">Seed Authorization</span>
        <span class="pill">Transfer Only</span>
    </div>
    {prefill_note}
</section>
{transfer_panel_html}
"#,
            prefill_note = if prefilled_wallet.is_empty() {
                String::new()
            } else {
                format!(
                    "<p class=\"metric-note break-anywhere\">Prefilled source wallet: {}</p>",
                    escape_html(prefilled_wallet),
                )
            },
            transfer_panel_html = transfer_panel_html,
        );

        return Html(layout("Worker Transfer", &transfer_only_body)).into_response();
    }

    let body = format!(
        r#"
<section class="hero hero-grid">
    <div class="hero-copy">
        <p class="eyebrow">ANET Ant Colony</p>
        <h1>Colony Intelligence Dashboard</h1>
        <p class="hero-sub muted">A detailed production view for investors and operators, combining activated Layer 1 supply, accumulated worker output, halving readiness, global worker reach, and live colony-group adoption.</p>
        <div class="hero-tags">
            <span class="pill">Genesis Activation</span>
            <span class="pill">TPoW Consensus</span>
            <span class="pill">Investor Metrics</span>
            <span class="pill">Colony Chat Signals</span>
        </div>
        <form class="search-form" action="/explorer/search" method="get">
            <input name="q" type="text" placeholder="Search block height, hash, or ANET wallet" required />
            <button type="submit">Search</button>
        </form>
    </div>
    <div class="hero-panel card">
        <div class="detail-kicker">Colony Status</div>
        <div class="hero-stat mono break-anywhere">{chain_id}</div>
        <div class="hero-meta-grid">
            {hero_metrics_html}
        </div>
    </div>
</section>
<section class="grid grid-metrics">
    {investor_cards_html}
</section>
{executive_panel_html}
{strategic_sections_html}
{block_diagnostics_html}
<section class="card section-surface">
    <div class="section-head"><div><p class="eyebrow">Ant Ledger</p><h2>Latest Blocks</h2></div><a class="action-ghost" href="/explorer/blocks">View all</a></div>
    <div class="list">{blocks_html}</div>
</section>
{transfer_panel_html}
"#,
        chain_id = summary.chain_id,
        hero_metrics_html = hero_metrics_html,
        investor_cards_html = investor_cards_html,
        executive_panel_html = executive_panel_html,
        strategic_sections_html = strategic_sections_html,
        block_diagnostics_html = block_diagnostics_html,
        blocks_html = blocks_html,
        transfer_panel_html = transfer_panel_html,
    );

    Html(layout("Explorer Dashboard", &body)).into_response()
}

async fn explorer_miners_portal(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
) -> impl IntoResponse {
    if explorer_auth_required() && authenticated_wallet_from_headers(&headers).is_none() {
        return Redirect::to("/explorer/login?next=%2Fexplorer%2Fminers").into_response();
    }

    let summary = {
        let state = context.state.read().await;
        state.network_summary()
    };
    let metrics = try_load_dashboard_metrics_fast().await;
    let wallet_label = authenticated_wallet_from_headers(&headers)
        .unwrap_or_else(|| "Open explorer mode".to_owned());
    let real_miners = metrics
        .as_ref()
        .map(|value| format_integer(value.total_real_miners))
        .unwrap_or_else(|| format_integer(summary.active_miners as u64));
    let active_workers = metrics
        .as_ref()
        .map(|value| format_integer(value.total_active_miners))
        .unwrap_or_else(|| format_integer(summary.active_miners as u64));
    let sessions_to_halving = metrics
        .as_ref()
        .map(|value| format_integer(value.remaining_sessions_to_halving))
        .unwrap_or_else(|| "Live sync pending".to_owned());
    let colony_rooms = metrics
        .as_ref()
        .map(|value| format_integer(value.total_colony_rooms))
        .unwrap_or_else(|| "Live sync pending".to_owned());
    let latest_block = summary
        .latest_block_height
        .map(|height| format!("#{}", height))
        .unwrap_or_else(|| "Pending".to_owned());

    let body = format!(
        r#"
<section class="hero compact-hero">
    <p class="eyebrow">Private Miner Access</p>
    <h1>Miners Portal</h1>
    <p class="hero-sub muted">This launch starts route-first inside the explorer so the current wallet gate, data plane, and branding stay intact. When you are ready, the same handlers can be fronted by <span class="mono">miners.a-network.net</span> without rebuilding the portal.</p>
    <div class="hero-tags">
        <a class="pill pill-link" href="/explorer">Back To Overview</a>
        <a class="pill pill-link" href="/explorer/build">Open Builder Portal</a>
        <a class="pill pill-link" href="/explorer/blocks">View Ledger</a>
    </div>
</section>
<section class="grid grid-metrics">
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Authenticated Wallet</div>
        <p class="metric metric-compact mono break-anywhere">{wallet_label}</p>
        <p class="metric-note">Current explorer session. Production access remains anchored to eligible in-app ANET wallets.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Real Miners</div>
        <p class="metric mono">{real_miners}</p>
        <p class="metric-note">Workers with completed sessions visible to the live portal snapshot.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Active Workers</div>
        <p class="metric mono">{active_workers}</p>
        <p class="metric-note">Workers mining or validating right now across the colony runtime.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Sessions To Halving</div>
        <p class="metric mono">{sessions_to_halving}</p>
        <p class="metric-note">This is the main miner-only operating number to surface before commercial builder access is sold.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Latest Block</div>
        <p class="metric mono">{latest_block}</p>
        <p class="metric-note">Most recent finalized settlement block on the ANET Layer 1 ledger.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Colony Rooms</div>
        <p class="metric mono">{colony_rooms}</p>
        <p class="metric-note">Tracked community rooms that can later feed private miner coordination and builder distribution lanes.</p>
    </article>
</section>
<section class="grid grid-two">
    <article class="card section-surface">
        <div class="section-head">
            <div><p class="eyebrow">Launch Structure</p><h2>Route-First, Subdomain-Ready</h2></div>
            <span class="muted">No new deployment surface is required to begin shipping the private portal.</span>
        </div>
        <div class="details details-strong">
            <div><span>Current Entry</span><strong class="mono">/explorer/miners</strong></div>
            <div><span>Future DNS</span><strong class="mono">miners.a-network.net</strong></div>
            <div><span>Wallet Gate</span><strong>{gate_mode}</strong></div>
            <div><span>Settlement Window</span><strong class="mono">{epoch_label}</strong></div>
            <div><span>Current Window Ends</span><strong class="mono">{countdown}</strong></div>
            <div><span>Payment Asset</span><strong>$ANET on BNB Chain</strong></div>
        </div>
    </article>
    <article class="card section-surface">
        <div class="section-head">
            <div><p class="eyebrow">Operational Lanes</p><h2>What Miners Control Here</h2></div>
            <span class="muted">The first portal slice focuses on control, access, and commercial handoff instead of creating a second explorer.</span>
        </div>
        <div class="list">
            <a class="list-row" href="/explorer/blocks"><span>Validator Ledger</span><span>Block history</span><span>Live</span><span>Trace miner-settled blocks</span></a>
            <a class="list-row" href="/explorer/build"><span>Builder Access</span><span>ANET plans</span><span>Draft</span><span>Move ecosystem sales into token-denominated rails</span></a>
            <a class="list-row" href="/explorer/api"><span>Infrastructure API</span><span>Machine access</span><span>Ready</span><span>Expose chain data to partners and tooling</span></a>
        </div>
    </article>
</section>
"#,
        wallet_label = wallet_label,
        real_miners = real_miners,
        active_workers = active_workers,
        sessions_to_halving = sessions_to_halving,
        latest_block = latest_block,
        colony_rooms = colony_rooms,
        gate_mode = if explorer_auth_required() {
            "Explorer wallet session required"
        } else {
            "Explorer auth disabled for this environment"
        },
        epoch_label = format_transfer_epoch_label(summary.epoch_seconds),
        countdown = seconds_to_countdown(summary.seconds_until_epoch_end),
    );

    Html(layout("Explorer Miners", &body)).into_response()
}

async fn explorer_builder_portal(
    headers: HeaderMap,
    AxumState(context): AxumState<RpcContext>,
) -> impl IntoResponse {
    if explorer_auth_required() && authenticated_wallet_from_headers(&headers).is_none() {
        return Redirect::to("/explorer/login?next=%2Fexplorer%2Fbuild").into_response();
    }

    let summary = {
        let state = context.state.read().await;
        state.network_summary()
    };
    let wallet_label = authenticated_wallet_from_headers(&headers)
        .unwrap_or_else(|| "Open explorer mode".to_owned());

    let body = format!(
        r#"
<section class="hero compact-hero">
    <p class="eyebrow">Builder / Ecosystem Access</p>
    <h1>Builder Portal</h1>
    <p class="hero-sub muted">This is the commercial layer for projects that want distribution, data, or launch visibility on A-Network. The public explorer stays public, while access and pricing move into a gated ANET-native portal.</p>
    <div class="hero-tags">
        <a class="pill pill-link" href="/explorer/miners">Open Miners Portal</a>
        <a class="pill pill-link" href="/explorer/api">Open API Portal</a>
        <a class="pill pill-link" href="/explorer">Back To Overview</a>
    </div>
</section>
<section class="grid grid-two">
    <article class="card section-surface">
        <div class="section-head">
            <div><p class="eyebrow">Access Rail</p><h2>Current Launch Gate</h2></div>
            <span class="muted">Builder onboarding is routed through the same explorer wallet gate first, then moved to explicit entitlements next.</span>
        </div>
        <div class="details details-strong">
            <div><span>Current Session</span><strong class="mono break-anywhere">{wallet_label}</strong></div>
            <div><span>Current Entry</span><strong class="mono">/explorer/build</strong></div>
            <div><span>Future DNS</span><strong class="mono">ecosystem.a-network.net</strong></div>
            <div><span>Payment Currency</span><strong>$ANET on BNB Chain</strong></div>
            <div><span>Ledger Context</span><strong>{latest_block}</strong></div>
            <div><span>Settlement Cadence</span><strong class="mono">{epoch_label}</strong></div>
        </div>
    </article>
    <article class="card section-surface">
        <div class="section-head">
            <div><p class="eyebrow">Commercial Buildout</p><h2>Backend Pieces To Wire Next</h2></div>
            <span class="muted">The UI is live now; the next slice is entitlement verification rather than another redesign pass.</span>
        </div>
        <div class="list">
            <div class="list-row"><span>Plans Table</span><span>products</span><span>Next</span><span>Store public plan metadata and ANET-denominated pricing</span></div>
            <div class="list-row"><span>Orders Table</span><span>checkout</span><span>Next</span><span>Track pending and settled builder purchases</span></div>
            <div class="list-row"><span>Entitlements</span><span>access</span><span>Next</span><span>Unlock routes after verified on-chain payment</span></div>
        </div>
    </article>
</section>
<section class="grid grid-metrics plan-grid">
    <article class="card stat-card-pro spotlight-card plan-card">
        <div class="detail-kicker">Founding Builder Pass</div>
        <p class="metric metric-compact mono">TBD ANET</p>
        <p class="metric-note">Draft slot for ecosystem teams that want listing, launch visibility, and private coordination with miners. Keep pricing token-native instead of mirroring a USD sticker.</p>
    </article>
    <article class="card stat-card-pro spotlight-card plan-card">
        <div class="detail-kicker">API / Data Relay</div>
        <p class="metric metric-compact mono">TBD ANET</p>
        <p class="metric-note">Reserved for projects consuming indexed chain data, alerts, or downstream explorer services through an ANET-denominated commercial rail.</p>
    </article>
    <article class="card stat-card-pro spotlight-card plan-card">
        <div class="detail-kicker">Launch Infrastructure</div>
        <p class="metric metric-compact mono">TBD ANET</p>
        <p class="metric-note">Reserved for premium launch support, ecosystem placement, and future promoted surfaces without hardcoding fiat pricing into the product.</p>
    </article>
</section>
<section class="card section-surface">
    <div class="section-head">
        <div><p class="eyebrow">Implementation Direction</p><h2>Portal Rollout</h2></div>
        <span class="muted">This keeps the public explorer clean while building the premium layer in-place.</span>
    </div>
    <div class="list">
        <a class="list-row" href="/explorer/miners"><span>Step 1</span><span>Private miner surface</span><span>Live</span><span>Use the existing explorer auth cookie and wallet eligibility gate</span></a>
        <div class="list-row"><span>Step 2</span><span>On-chain ANET checkout</span><span>Next</span><span>Verify BNB Chain payment receipts before granting builder access</span></div>
        <div class="list-row"><span>Step 3</span><span>Subdomain handoff</span><span>Later</span><span>Point dedicated DNS at these same handlers when the product split is ready</span></div>
    </div>
</section>
"#,
        wallet_label = wallet_label,
        latest_block = summary
            .latest_block_height
            .map(|height| format!("#{}", height))
            .unwrap_or_else(|| "Pending".to_owned()),
        epoch_label = format_transfer_epoch_label(summary.epoch_seconds),
    );

    Html(layout("Explorer Build", &body)).into_response()
}

async fn explorer_territory(
    Path(slug): Path<String>,
    AxumState(context): AxumState<RpcContext>,
) -> Result<Html<String>, (StatusCode, Json<ApiError>)> {
    let summary = {
        let state = context.state.read().await;
        state.network_summary()
    };

    let metrics = load_dashboard_metrics_fast().await?;

    let territory = metrics
        .top_countries
        .iter()
        .find(|row| territory_slug(&row.country) == slug)
        .cloned()
        .ok_or_else(|| not_found(format!("territory {slug} not found")))?;

    let territory_colonies = load_territory_colony_usage_fast(&territory.country).await?;
    let territory_rooms = load_territory_room_profiles_fast(&territory.country).await?;

    let territory_room_count = territory_colonies
        .iter()
        .map(|row| row.room_count)
        .sum::<u64>();
    let territory_active_ants = territory_colonies
        .iter()
        .map(|row| row.active_chat_ants)
        .sum::<u64>();
    let territory_message_count = territory_colonies
        .iter()
        .map(|row| row.message_count)
        .sum::<u64>();

    let worker_share = percentage(territory.workers, metrics.total_real_miners.max(1));
    let room_share = percentage(territory_room_count, metrics.total_colony_rooms.max(1));
    let participant_share = percentage(
        territory_active_ants,
        metrics.total_group_participants.max(1),
    );
    let message_share = percentage(territory_message_count, metrics.total_group_messages.max(1));

    let territory_colonies_html = if territory_colonies.is_empty() {
        "<p class=\"muted\">No ANT Colonies are indexed for this territory yet.</p>".to_owned()
    } else {
        format!(
            "<div class=\"list\">{}</div>",
            territory_colonies
                .iter()
                .map(|row| {
                    format!(
                        "<a class=\"list-row\" href=\"/explorer/colonies/{slug}\"><span>{label}</span><span>{rooms} rooms</span><span>{ants} ants</span><span>{messages} messages</span></a>",
                        slug = colony_slug(&row.room_name),
                        label = escape_html(&row.room_name),
                        rooms = format_integer(row.room_count),
                        ants = format_integer(row.active_chat_ants),
                        messages = format_integer(row.message_count),
                    )
                })
                .collect::<Vec<_>>()
                .join("")
        )
    };

    let territory_rooms_html = if territory_rooms.is_empty() {
        "<p class=\"muted\">No owner rooms were found for this territory yet.</p>".to_owned()
    } else {
        format!(
            "<div class=\"list\">{}</div>",
            territory_rooms
                .iter()
                .map(|room| {
                    format!(
                        "<a class=\"list-row\" href=\"/explorer/rooms/{room_key}\"><span>{owner_label}</span><span>{colony}</span><span>{ants} ants</span><span>{messages_30d} msgs / 30d</span></a>",
                        room_key = escape_html(&room.room_key),
                        owner_label = escape_html(&room.owner_label),
                        colony = escape_html(&room.room_name),
                        ants = format_integer(room.ants_count),
                        messages_30d = format_integer(room.messages_30d),
                    )
                })
                .collect::<Vec<_>>()
                .join("")
        )
    };

    let top_colony_label = territory_colonies
        .first()
        .map(|row| escape_html(&row.room_name))
        .unwrap_or_else(|| "No colony yet".to_owned());

    let body = format!(
        r#"
<section class="hero compact-hero colony-hero">
    <p class="eyebrow">ANT Territory Drilldown</p>
    <h1>{territory}</h1>
    <p class="hero-sub muted">A focused territory view showing the worker footprint in this ANT Territory and the ANT Colony labels currently active inside it.</p>
    <div class="hero-tags">
        <a class="pill pill-link" href="/explorer">Back To Overview</a>
        <a class="pill pill-link" href="/stats/investor">Investor Metrics API</a>
    </div>
</section>
<section class="grid grid-metrics colony-metrics-grid">
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Verified Workers</div>
        <p class="metric mono">{workers}</p>
        <p class="metric-note">This territory represents {worker_share} of all verified workers currently indexed by the network.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">ANT Colonies</div>
        <p class="metric mono">{colony_count}</p>
        <p class="metric-note">Distinct colony labels currently visible inside this territory.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Territory Rooms</div>
        <p class="metric mono">{rooms}</p>
        <p class="metric-note">These rooms account for {room_share} of all tracked colony rooms.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Active Chat Ants</div>
        <p class="metric mono">{ants}</p>
        <p class="metric-note">This territory represents {participant_share} of all ants participating in tracked group chat.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Message Flow</div>
        <p class="metric mono">{messages}</p>
        <p class="metric-note">This territory produced {message_share} of all tracked group messages.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Top Colony</div>
        <p class="metric break-anywhere">{top_colony_label}</p>
        <p class="metric-note">Leading ANT Colony label currently indexed inside this territory.</p>
    </article>
</section>
<section class="card section-surface">
    <div class="section-head">
        <div>
            <p class="eyebrow">Territory Position</p>
            <h2>Share Of Global Community Activity</h2>
        </div>
        <span class="muted">These progress lanes compare this ANT Territory against the currently indexed global worker and colony footprint.</span>
    </div>
    <div class="executive-stack">
        <div class="executive-meter">
            <div class="executive-head"><strong>Worker Share</strong><span>{worker_share}</span></div>
            <div class="progress-track executive-track"><span style="width: {worker_share};"></span></div>
        </div>
        <div class="executive-meter">
            <div class="executive-head"><strong>Room Share</strong><span>{room_share}</span></div>
            <div class="progress-track executive-track"><span style="width: {room_share};"></span></div>
        </div>
        <div class="executive-meter">
            <div class="executive-head"><strong>Participant Share</strong><span>{participant_share}</span></div>
            <div class="progress-track executive-track"><span style="width: {participant_share};"></span></div>
        </div>
        <div class="executive-meter">
            <div class="executive-head"><strong>Message Share</strong><span>{message_share}</span></div>
            <div class="progress-track executive-track"><span style="width: {message_share};"></span></div>
        </div>
    </div>
    <div class="details details-strong signal-grid">
        <div><span>Global Countries</span><strong class="mono">{countries}</strong></div>
        <div><span>Active Workers Now</span><strong class="mono">{active_miners}</strong></div>
        <div><span>Latest Block</span><strong class="mono">{latest_block}</strong></div>
        <div><span>Epoch Ends</span><strong class="mono break-anywhere">{epoch_end}</strong></div>
    </div>
</section>
<section class="card section-surface">
    <div class="section-head">
        <div>
            <p class="eyebrow">ANT Colony</p>
            <h2>Colonies In This Territory</h2>
        </div>
        <span class="muted">Click a colony to open its dedicated drilldown page.</span>
    </div>
    {territory_colonies_html}
</section>
<section class="card section-surface">
    <div class="section-head">
        <div>
            <p class="eyebrow">Owner Rooms</p>
            <h2>Rooms In This Territory</h2>
        </div>
        <span class="muted">Click a room owner row to inspect the underlying colony room profile.</span>
    </div>
    {territory_rooms_html}
</section>
"#,
        territory = escape_html(&territory.country),
        workers = format_integer(territory.workers),
        worker_share = format_percent(worker_share),
        colony_count = format_integer(territory_colonies.len() as u64),
        rooms = format_integer(territory_room_count),
        room_share = format_percent(room_share),
        ants = format_integer(territory_active_ants),
        participant_share = format_percent(participant_share),
        messages = format_integer(territory_message_count),
        message_share = format_percent(message_share),
        top_colony_label = top_colony_label,
        countries = format_integer(metrics.country_count),
        active_miners = format_integer(metrics.total_active_miners),
        latest_block = summary
            .latest_block_height
            .map(|height| format!("#{height}"))
            .unwrap_or_else(|| "Pending".to_owned()),
        epoch_end = summary.current_epoch_end.to_rfc3339(),
        territory_colonies_html = territory_colonies_html,
        territory_rooms_html = territory_rooms_html,
    );

    Ok(Html(layout(
        &format!("Territory {}", territory.country),
        &body,
    )))
}

async fn explorer_colony(
    Path(slug): Path<String>,
    AxumState(context): AxumState<RpcContext>,
) -> Result<Html<String>, (StatusCode, Json<ApiError>)> {
    let summary = {
        let state = context.state.read().await;
        state.network_summary()
    };

    let metrics = load_dashboard_metrics_fast().await?;

    let selected_label = metrics
        .group_usage
        .iter()
        .find(|row| colony_slug(&row.room_name) == slug)
        .map(|row| row.room_name.clone())
        .or_else(|| {
            preferred_colony_labels()
                .iter()
                .find(|label| colony_slug(label) == slug)
                .map(|label| (*label).to_owned())
        })
        .ok_or_else(|| not_found(format!("colony {slug} not found")))?;

    let room_profiles = load_colony_room_profiles_fast(&selected_label).await?;

    let selected_usage = metrics
        .group_usage
        .iter()
        .find(|row| row.room_name == selected_label)
        .cloned()
        .unwrap_or(db::ColonyGroupUsageRow {
            room_name: selected_label.clone(),
            room_count: 0,
            active_chat_ants: 0,
            message_count: 0,
            top_owner_label: "No owner yet".to_owned(),
        });

    let room_share = percentage(selected_usage.room_count, metrics.total_colony_rooms.max(1));
    let participant_share = percentage(
        selected_usage.active_chat_ants,
        metrics.total_group_participants.max(1),
    );
    let message_share = percentage(
        selected_usage.message_count,
        metrics.total_group_messages.max(1),
    );

    let mut leaderboard_rows = metrics.group_usage.clone();
    for label in preferred_colony_labels() {
        if !leaderboard_rows.iter().any(|row| row.room_name == label) {
            leaderboard_rows.push(db::ColonyGroupUsageRow {
                room_name: label.to_owned(),
                room_count: 0,
                active_chat_ants: 0,
                message_count: 0,
                top_owner_label: "No owner yet".to_owned(),
            });
        }
    }
    leaderboard_rows.sort_by(|left, right| {
        right
            .room_count
            .cmp(&left.room_count)
            .then(right.active_chat_ants.cmp(&left.active_chat_ants))
            .then(left.room_name.cmp(&right.room_name))
    });

    let leaderboard_html = leaderboard_rows
        .iter()
        .map(|row| {
            format!(
                r#"
        <a class="list-row" href="/explorer/colonies/{slug}"><span>{label}</span><span>{rooms} rooms</span><span>{ants} ants</span><span>{messages} messages</span></a>
"#,
                slug = colony_slug(&row.room_name),
                label = row.room_name,
                rooms = format_integer(row.room_count),
                ants = format_integer(row.active_chat_ants),
                messages = format_integer(row.message_count),
            )
        })
        .collect::<Vec<_>>()
        .join("");

    let room_profiles_html = if room_profiles.is_empty() {
        "<p class=\"muted\">No owner rooms were found for this colony label yet.</p>".to_owned()
    } else {
        format!(
            "<div class=\"list\">{}</div>",
            room_profiles
                .iter()
                .map(|room| {
                    format!(
                        "<a class=\"list-row\" href=\"/explorer/rooms/{room_key}\"><span>{owner_label}</span><span>{ants} ants</span><span>{status}</span><span>{messages_30d} msgs / 30d</span></a>",
                        room_key = escape_html(&room.room_key),
                        owner_label = escape_html(&room.owner_label),
                        ants = format_integer(room.ants_count),
                        status = escape_html(&room.status),
                        messages_30d = format_integer(room.messages_30d),
                    )
                })
                .collect::<Vec<_>>()
                .join("")
        )
    };

    let body = format!(
        r#"
<section class="hero compact-hero colony-hero">
    <p class="eyebrow">Colony Drilldown</p>
    <h1>{label}</h1>
    <p class="hero-sub muted">A focused analytics view for this colony label, covering room adoption, active chat participation, message flow, and its relative share of the global community layer.</p>
    <div class="hero-tags">
        <a class="pill pill-link" href="/explorer">Back To Overview</a>
        <a class="pill pill-link" href="/stats/investor">Investor Metrics API</a>
    </div>
</section>
<section class="grid grid-metrics colony-metrics-grid">
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Colony Rooms</div>
        <p class="metric mono">{rooms}</p>
        <p class="metric-note">This label accounts for {room_share} of all tracked colony rooms.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Active Chat Ants</div>
        <p class="metric mono">{ants}</p>
        <p class="metric-note">This colony represents {participant_share} of all ants participating in tracked group chat.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Message Flow</div>
        <p class="metric mono">{messages}</p>
        <p class="metric-note">This colony produced {message_share} of all tracked group messages.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Network Context</div>
        <p class="metric mono">{countries}</p>
        <p class="metric-note">Global worker reach spans {countries} countries, while the colony engine is currently on block {latest_block}.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Top Owner</div>
        <p class="metric break-anywhere">{top_owner_label}</p>
        <p class="metric-note">Live owner label currently leading this colony group by chat participation and message flow.</p>
    </article>
</section>
<section class="card section-surface">
    <div class="section-head">
        <div>
            <p class="eyebrow">Colony Position</p>
            <h2>Share Of Global Community Activity</h2>
        </div>
        <span class="muted">These progress lanes compare this colony label against the total community footprint currently indexed by the investor dashboard.</span>
    </div>
    <div class="executive-stack">
        <div class="executive-meter">
            <div class="executive-head"><strong>Room Share</strong><span>{room_share}</span></div>
            <div class="progress-track executive-track"><span style="width: {room_share};"></span></div>
        </div>
        <div class="executive-meter">
            <div class="executive-head"><strong>Participant Share</strong><span>{participant_share}</span></div>
            <div class="progress-track executive-track"><span style="width: {participant_share};"></span></div>
        </div>
        <div class="executive-meter">
            <div class="executive-head"><strong>Message Share</strong><span>{message_share}</span></div>
            <div class="progress-track executive-track"><span style="width: {message_share};"></span></div>
        </div>
    </div>
    <div class="details details-strong signal-grid">
        <div><span>Accumulated Colony Work</span><strong class="mono">{accumulated_anet} ANET</strong></div>
        <div><span>Sessions To Halving</span><strong class="mono">{sessions_left}</strong></div>
        <div><span>Active Workers Now</span><strong class="mono">{active_miners}</strong></div>
        <div><span>Epoch Ends</span><strong class="mono break-anywhere">{epoch_end}</strong></div>
    </div>
</section>
<section class="card section-surface">
    <div class="section-head">
        <div>
            <p class="eyebrow">Colony Rankboard</p>
            <h2>All Colony Labels</h2>
        </div>
        <span class="muted">Jump between labels to inspect their current community footprint.</span>
    </div>
    <div class="list">{leaderboard_html}</div>
</section>
<section class="card section-surface">
    <div class="section-head">
        <div>
            <p class="eyebrow">Owner Rooms</p>
            <h2>Rooms In This Colony</h2>
        </div>
        <span class="muted">Click a room owner row to open the room profile with live ants and daily-to-monthly activity windows.</span>
    </div>
    {room_profiles_html}
</section>
"#,
        label = selected_label,
        rooms = format_integer(selected_usage.room_count),
        room_share = format_percent(room_share),
        ants = format_integer(selected_usage.active_chat_ants),
        participant_share = format_percent(participant_share),
        messages = format_integer(selected_usage.message_count),
        message_share = format_percent(message_share),
        countries = format_integer(metrics.country_count),
        latest_block = summary
            .latest_block_height
            .map(|height| format!("#{height}"))
            .unwrap_or_else(|| "Pending".to_owned()),
        accumulated_anet = state::format_anet_fixed(metrics.total_accumulated_ants),
        sessions_left = format_integer(metrics.remaining_sessions_to_halving),
        active_miners = format_integer(metrics.total_active_miners),
        epoch_end = summary.current_epoch_end.to_rfc3339(),
        top_owner_label = escape_html(&selected_usage.top_owner_label),
        leaderboard_html = leaderboard_html,
        room_profiles_html = room_profiles_html,
    );

    Ok(Html(layout(&format!("Colony {}", selected_label), &body)))
}

async fn explorer_room(
    Path(room_key): Path<String>,
    headers: HeaderMap,
) -> Result<Html<String>, (StatusCode, Json<ApiError>)> {
    if should_short_circuit_room_bot_scan(&headers, &room_key) {
        return Err(not_found(format!("room {room_key} not found")));
    }

    let room = load_colony_room_profile_fast(&room_key)
        .await?
        .ok_or_else(|| not_found(format!("room {room_key} not found")))?;

    let activity_note = match room.status.as_str() {
        "Active" => "This room had message activity within the last 24 hours.",
        "Warm" => "This room was active within the last 7 days.",
        "Quiet" => "This room had activity in the last 30 days but not in the last week.",
        _ => "This room has no tracked message activity in the last 30 days.",
    };

    let body = format!(
        r#"
<section class="hero compact-hero colony-hero">
    <p class="eyebrow">Owner Room Profile</p>
    <h1>{owner_label}</h1>
    <p class="hero-sub muted">A focused room profile for this colony owner, including live ant participation, message totals, and recent activity windows.</p>
    <div class="hero-tags">
        <a class="pill pill-link" href="/explorer/colonies/{colony_slug}">Back To Colony</a>
        <span class="pill">{status}</span>
        <span class="pill mono">Room {room_key}</span>
    </div>
</section>
<section class="grid grid-metrics colony-metrics-grid">
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Owner</div>
        <p class="metric break-anywhere">{owner_label}</p>
        <p class="metric-note">Owner profile label for this room inside the colony group.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Ants In Room</div>
        <p class="metric mono">{ants_count}</p>
        <p class="metric-note">Distinct ants who posted in this room.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Total Messages</div>
        <p class="metric mono">{total_messages}</p>
        <p class="metric-note">All tracked messages recorded for this room.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Room Status</div>
        <p class="metric">{status}</p>
        <p class="metric-note">{activity_note}</p>
    </article>
</section>
<section class="card section-surface">
    <div class="section-head">
        <div><p class="eyebrow">Recent Activity</p><h2>Daily To Monthly Windows</h2></div>
        <span class="muted">Short-range visibility for this owner room.</span>
    </div>
    <div class="details details-strong signal-grid">
        <div><span>Messages 24h</span><strong class="mono">{messages_24h}</strong></div>
        <div><span>Messages 7d</span><strong class="mono">{messages_7d}</strong></div>
        <div><span>Messages 30d</span><strong class="mono">{messages_30d}</strong></div>
        <div><span>Last Activity</span><strong class="mono break-anywhere">{last_activity_at}</strong></div>
        <div><span>Room Created</span><strong class="mono break-anywhere">{room_created_at}</strong></div>
        <div><span>Room Updated</span><strong class="mono break-anywhere">{room_updated_at}</strong></div>
        <div><span>Owner User ID</span><strong class="mono">{owner_user_id}</strong></div>
        <div><span>Colony Label</span><strong>{room_name}</strong></div>
    </div>
</section>
"#,
        owner_label = escape_html(&room.owner_label),
        colony_slug = colony_slug(&room.room_name),
        status = escape_html(&room.status),
        room_key = escape_html(&room.room_key),
        ants_count = format_integer(room.ants_count),
        total_messages = format_integer(room.total_messages),
        activity_note = activity_note,
        messages_24h = format_integer(room.messages_24h),
        messages_7d = format_integer(room.messages_7d),
        messages_30d = format_integer(room.messages_30d),
        last_activity_at = escape_html(
            room.last_activity_at
                .as_deref()
                .unwrap_or("No activity yet")
        ),
        room_created_at = escape_html(room.room_created_at.as_deref().unwrap_or("Unknown")),
        room_updated_at = escape_html(room.room_updated_at.as_deref().unwrap_or("Unknown")),
        owner_user_id = format_integer(room.owner_user_id),
        room_name = escape_html(&room.room_name),
    );

    Ok(Html(layout(&format!("Room {}", room.owner_label), &body)))
}

async fn explorer_blocks(AxumState(context): AxumState<RpcContext>) -> Html<String> {
    let state = context.state.read().await;
    let blocks = state.all_blocks();

    let rows = if blocks.is_empty() {
        "<p class=\"muted\">No blocks yet.</p>".to_owned()
    } else {
        blocks
            .iter()
            .rev()
            .map(|block| {
                let block_kind = if block.transactions.is_empty() {
                    if block.activated_supply_ants > 0 {
                        "Settlement"
                    } else {
                        "Anchor"
                    }
                } else if block.activated_supply_ants > 0 {
                    "Transfer + Settlement"
                } else {
                    "Transfer"
                };
                format!(
                    "<a class=\"list-row\" href=\"/explorer/blocks/{height}\"><span>Block #{height}</span><span>{start}</span><span>{tx_count} tx</span><span>{activated_supply_anet} ANET ({activated_supply} ANTS) activated</span><span>{block_kind}</span></a>",
                    height = block.block_height,
                    start = block.epoch_start.to_rfc3339(),
                    tx_count = block.transactions.len(),
                    activated_supply = format_integer(block.activated_supply_ants),
                    activated_supply_anet = state::format_anet_fixed(block.activated_supply_ants),
                    block_kind = block_kind,
                )
            })
            .collect::<Vec<_>>()
            .join("")
    };

    Html(layout(
        "Explorer Blocks",
        &format!(
            r#"
<section class="hero compact-hero">
    <p class="eyebrow">Ant Ledger</p>
    <h1>Block Ledger</h1>
    <p class="hero-sub muted">A complete colony ledger view with block timestamps, ant-fee totals, and worker settlement activity.</p>
</section>
<section class="card section-surface">
    <div class="section-head"><div><p class="eyebrow">Ledger</p><h2>All Blocks</h2></div><a class="action-ghost" href="/explorer">Colony overview</a></div>
    <div class="list">{rows}</div>
</section>
"#,
            rows = rows,
        ),
    ))
}

async fn explorer_api(AxumState(context): AxumState<RpcContext>) -> Html<String> {
    let (summary, latest_block, sample_account) = {
        let state = context.state.read().await;
        (
            state.network_summary(),
            state.blocks.last().cloned(),
            state.accounts.keys().next().cloned(),
        )
    };

    let account_endpoint = sample_account
        .as_ref()
        .map(|address| format!("/accounts/{address}"))
        .unwrap_or_else(|| "/accounts/ANET...".to_owned());

    let health_preview = pretty_json(&HealthResponse {
        status: "ok",
        chain_id: summary.chain_id.clone(),
        latest_block_height: summary.latest_block_height,
    });
    let block_preview = latest_block
        .as_ref()
        .map(pretty_json)
        .unwrap_or_else(|| "{\n  \"message\": \"No blocks yet\"\n}".to_owned());
    let account_preview = sample_account
        .as_ref()
        .map(|address| {
            pretty_json(&AccountView {
                address: address.clone(),
                ants_balance: 0,
                anet_balance: state::format_anet_fixed(0),
                sessions: 0,
                is_validator: false,
            })
        })
        .unwrap_or_else(|| {
            "{\n  \"address\": \"ANET...\",\n  \"ants_balance\": 0,\n  \"anet_balance\": \"0.00000000\",\n  \"sessions\": 0,\n  \"is_validator\": false\n}"
                .to_owned()
        });
    let latest_validator_links = latest_block
        .as_ref()
        .map(|block| {
            if block.miners.is_empty() {
                "<p class=\"muted\">No validator wallets were recorded for the latest block.</p>"
                    .to_owned()
            } else {
                format!(
                    "<div class=\"wallet-list\">{}</div>",
                    block
                        .miners
                        .iter()
                        .map(|address| wallet_pill(address))
                        .collect::<Vec<_>>()
                        .join("")
                )
            }
        })
        .unwrap_or_else(|| {
            "<p class=\"muted\">No block validators are available yet.</p>".to_owned()
        });
    let sample_account_link = sample_account
        .as_ref()
        .map(|address| wallet_pill(address))
        .unwrap_or_else(|| "<span class=\"pill\">No activated wallet yet</span>".to_owned());

    let body = format!(
        r#"
<section class="hero compact-hero">
    <p class="eyebrow">ANET RPC</p>
    <h1>Explorer API Portal</h1>
    <p class="hero-sub muted">Machine-readable endpoints are still available, but this page presents them in an ANET explorer style instead of raw responses by default.</p>
    <div class="hero-tags">
        <a class="pill pill-link" href="/blocks">Raw Blocks JSON</a>
        <a class="pill pill-link" href="/stats/investor">Investor Metrics JSON</a>
        <a class="pill pill-link" href="/health">Health JSON</a>
    </div>
</section>
<section class="grid grid-two">
    <article class="card section-surface">
        <div class="section-head">
            <div><p class="eyebrow">Chain Data</p><h2>Explorer Endpoints</h2></div>
            <span class="muted">Ethereum-style endpoint index, adapted to worker epochs and ANTS accounting.</span>
        </div>
        <div class="list">
            <a class="list-row" href="/blocks"><span>GET /blocks</span><span>All blocks</span><span>Raw JSON</span><span>Ledger feed</span></a>
            <a class="list-row" href="/explorer/blocks"><span>/explorer/blocks</span><span>Human view</span><span>Styled</span><span>Ledger explorer</span></a>
            <a class="list-row" href="/stats/investor"><span>GET /stats/investor</span><span>Metrics</span><span>Raw JSON</span><span>Investor data</span></a>
            <a class="list-row" href="{account_endpoint}"><span>{account_endpoint}</span><span>Wallet state</span><span>Raw JSON</span><span>Account endpoint</span></a>
        </div>
    </article>
    <article class="card section-surface">
        <div class="section-head">
            <div><p class="eyebrow">Network State</p><h2>Runtime Snapshot</h2></div>
            <span class="muted">Current chain identity and fast transfer-block status.</span>
        </div>
        <div class="details details-strong">
            <div><span>Chain ID</span><strong class="mono break-anywhere">{chain_id}</strong></div>
            <div><span>Latest Block</span><strong class="mono">{latest_block}</strong></div>
            <div><span>Transfer Block End</span><strong class="mono break-anywhere">{epoch_end}</strong></div>
            <div><span>Transfer Cadence</span><strong class="mono">{epoch_label}</strong></div>
            <div><span>Activated Supply</span><strong class="mono">{activated_supply}</strong></div>
        </div>
        <div class="account-actions">
            <a class="action-link" href="/explorer/health">Open Health Dashboard</a>
            <a class="action-ghost" href="/ready">Raw Ready JSON</a>
        </div>
    </article>
</section>
<section class="grid grid-two">
    <article class="card section-surface">
        <div class="section-head"><div><p class="eyebrow">Sample</p><h2>Health Payload</h2></div><a class="action-ghost" href="/health">Open Raw</a></div>
        <div class="tx-result"><pre class="mono break-anywhere">{health_preview}</pre></div>
        <div class="section-head" style="margin-top: 18px;"><div><p class="eyebrow">Linked Wallets</p><h2>Latest Validator Wallets</h2></div></div>
        {latest_validator_links}
    </article>
    <article class="card section-surface">
        <div class="section-head"><div><p class="eyebrow">Sample</p><h2>Latest Block Payload</h2></div><a class="action-ghost" href="/blocks">Open Raw</a></div>
        <div class="tx-result"><pre class="mono break-anywhere">{block_preview}</pre></div>
    </article>
</section>
<section class="card section-surface">
    <div class="section-head"><div><p class="eyebrow">Sample</p><h2>Account Payload</h2></div><a class="action-ghost" href="{account_endpoint}">Open Raw</a></div>
    <div class="tx-result"><pre class="mono break-anywhere">{account_preview}</pre></div>
    <div class="section-head" style="margin-top: 18px;"><div><p class="eyebrow">Wallet Link</p><h2>Sample Activated Wallet</h2></div></div>
    <div class="wallet-list">{sample_account_link}</div>
</section>
"#,
        account_endpoint = account_endpoint,
        chain_id = summary.chain_id,
        latest_block = summary
            .latest_block_height
            .map(|height| format!("#{height}"))
            .unwrap_or_else(|| "Pending".to_owned()),
        epoch_end = summary.current_epoch_end.to_rfc3339(),
        epoch_label = format_transfer_epoch_label(summary.epoch_seconds),
        activated_supply = summary.total_anet,
        health_preview = health_preview,
        block_preview = block_preview,
        account_preview = account_preview,
        latest_validator_links = latest_validator_links,
        sample_account_link = sample_account_link,
    );

    Html(layout("Explorer API", &body))
}

async fn explorer_health(AxumState(context): AxumState<RpcContext>) -> Html<String> {
    let summary = {
        let state = context.state.read().await;
        state.network_summary()
    };

    let postgres_ready = postgres_ready_fast().await;
    let health_preview = pretty_json(&HealthResponse {
        status: "ok",
        chain_id: summary.chain_id.clone(),
        latest_block_height: summary.latest_block_height,
    });
    let readiness_preview = if postgres_ready {
        pretty_json(&ReadinessResponse {
            status: "ready",
            postgres: "ok",
            genesis_accounts: 0,
        })
    } else {
        "{\n  \"status\": \"degraded\",\n  \"postgres\": \"unreachable\"\n}".to_owned()
    };

    let latest_block_card = summary
        .latest_block_height
        .map(|height| {
            format!(
                r#"<a class="card stat-card-pro spotlight-card card-link" href="/explorer/blocks/{height}">
        <div class="detail-kicker">Latest Block</div>
        <p class="metric mono">#{height}</p>
        <p class="metric-note">Most recent finalized settlement block.</p>
    </a>"#,
            )
        })
        .unwrap_or_else(|| {
            r#"<article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Latest Block</div>
        <p class="metric mono">Pending</p>
        <p class="metric-note">No settlement block has been finalized yet.</p>
    </article>"#
                .to_owned()
        });

    let body = format!(
        r#"
<section class="hero compact-hero">
    <p class="eyebrow">Node Monitor</p>
    <h1>Colony Health Dashboard</h1>
    <p class="hero-sub muted">A branded health and readiness screen for the ANET node. Layer 1 opens 2-second settlement windows while Web2 mining sessions remain on the separate 6-hour model.</p>
</section>
<section class="grid grid-metrics">
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Chain ID</div>
        <p class="metric metric-chain mono break-anywhere">{chain_id}</p>
        <p class="metric-note">Current Layer 1 ledger identity.</p>
    </article>
    {latest_block_card}
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Postgres Link</div>
        <p class="metric mono">{postgres_state}</p>
        <p class="metric-note">Database reachability for validator refresh and Web2 visibility.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Current Window Ends</div>
        <p class="metric mono">{countdown}</p>
        <p class="metric-note break-anywhere">This settlement window closes at {epoch_end}. A block is created only when transfers or newly synchronized ANTS supply exist.</p>
    </article>
    <article class="card stat-card-pro spotlight-card">
        <div class="detail-kicker">Settlement Window</div>
        <p class="metric metric-compact mono">{epoch_label}</p>
        <p class="metric-note">Current Layer 1 settlement cadence for transfers and synchronized supply.</p>
    </article>
</section>
<section class="grid grid-two">
    <article class="card section-surface">
        <div class="section-head"><div><p class="eyebrow">Liveness</p><h2>Health Payload</h2></div><a class="action-ghost" href="/health">Open Raw</a></div>
        <div class="tx-result"><pre class="mono break-anywhere">{health_preview}</pre></div>
    </article>
    <article class="card section-surface">
        <div class="section-head"><div><p class="eyebrow">Dependencies</p><h2>Readiness Payload</h2></div><a class="action-ghost" href="/ready">Open Raw</a></div>
        <div class="tx-result"><pre class="mono break-anywhere">{readiness_preview}</pre></div>
    </article>
</section>
"#,
        chain_id = summary.chain_id,
        latest_block_card = latest_block_card,
        postgres_state = if postgres_ready { "ONLINE" } else { "DEGRADED" },
        countdown = seconds_to_countdown(summary.seconds_until_epoch_end),
        epoch_end = summary.current_epoch_end.to_rfc3339(),
        epoch_label = format_transfer_epoch_label(summary.epoch_seconds),
        health_preview = health_preview,
        readiness_preview = readiness_preview,
    );

    Html(layout("Explorer Health", &body))
}

async fn explorer_search(
    Query(query): Query<ExplorerSearchQuery>,
    AxumState(context): AxumState<RpcContext>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let needle = query.q.trim();
    if needle.is_empty() {
        return Ok(Redirect::to("/explorer").into_response());
    }

    let state = context.state.read().await;

    if needle.chars().all(|ch| ch.is_ascii_digit()) {
        if let Ok(height) = needle.parse::<u64>() {
            if state
                .blocks
                .iter()
                .any(|block| block.block_height == height)
            {
                return Ok(Redirect::to(&format!("/explorer/blocks/{height}")).into_response());
            }
        }
    }

    let wallet = needle.to_uppercase();
    if wallet.starts_with("ANET") && state.accounts.contains_key(&wallet) {
        return Ok(Redirect::to(&format!("/explorer/accounts/{wallet}")).into_response());
    }

    if let Some(block) = state.block_by_id(needle) {
        return Ok(
            Redirect::to(&format!("/explorer/blocks/{}", block.block_height)).into_response(),
        );
    }

    let summary = state.network_summary();
    drop(state);

    let body = format!(
        r#"
<section class="hero compact-hero">
    <p class="eyebrow">Explorer Search</p>
    <h1>No Match Found</h1>
    <p class="hero-sub muted">The search term <strong>{needle}</strong> did not match a block height, block hash, or activated ANET wallet in the current node state.</p>
    <div class="hero-tags">
        <a class="pill pill-link" href="/explorer">Back To Dashboard</a>
        <a class="pill pill-link" href="/explorer/blocks">Open Ledger</a>
        <a class="pill pill-link" href="/explorer/api">Open API Portal</a>
    </div>
</section>
<section class="card section-surface">
    <div class="section-head"><div><p class="eyebrow">Try Again</p><h2>Search The Colony</h2></div><span class="muted">Use a block height, full block hash, or ANET wallet address.</span></div>
    <form class="search-form" action="/explorer/search" method="get">
        <input name="q" type="text" value="{needle}" placeholder="Search block height, hash, or ANET wallet" required />
        <button type="submit">Search</button>
    </form>
    <div class="details details-strong" style="margin-top: 18px;">
        <div><span>Chain ID</span><strong class="mono break-anywhere">{chain_id}</strong></div>
        <div><span>Latest Block</span><strong class="mono">{latest_block}</strong></div>
        <div><span>Epoch End</span><strong class="mono break-anywhere">{epoch_end}</strong></div>
    </div>
</section>
"#,
        needle = needle,
        chain_id = summary.chain_id,
        latest_block = summary
            .latest_block_height
            .map(|height| format!("#{height}"))
            .unwrap_or_else(|| "Pending".to_owned()),
        epoch_end = summary.current_epoch_end.to_rfc3339(),
    );

    Ok(Html(layout("Explorer Search", &body)).into_response())
}

async fn explorer_block(
    Path(height): Path<u64>,
    AxumState(context): AxumState<RpcContext>,
) -> Result<Html<String>, (StatusCode, Json<ApiError>)> {
    let state = context.state.read().await;
    let block = state
        .blocks
        .iter()
        .find(|block| block.block_height == height)
        .cloned()
        .ok_or_else(|| not_found(format!("block {height} not found")))?;

    let transactions = if block.transactions.is_empty() {
        "<p class=\"muted\">No transactions were included in this epoch.</p>".to_owned()
    } else {
        block
            .transactions
            .iter()
            .map(|tx| {
                let memo_html = if tx.memo.trim().is_empty() {
                    "<span class=\"muted\">No memo</span>".to_owned()
                } else {
                    format!(
                        "<span class=\"tx-memo\">Memo: {}</span>",
                        escape_html(&tx.memo)
                    )
                };
                format!(
                    "<div class=\"tx-row\"><strong>{from}</strong><span>{amount} ANTS</span><strong>{to}</strong><span>Fee {fee} ANTS</span><span class=\"tx-status confirmed\">Confirmed in Block #{height}</span>{memo}</div>",
                    from = wallet_link(&tx.from),
                    amount = format_integer(tx.amount_ants),
                    to = wallet_link(&tx.to),
                    fee = tx.fee_ants,
                    height = block.block_height,
                    memo = memo_html,
                )
            })
            .collect::<Vec<_>>()
            .join("")
    };
    let miner_wallets = if block.miners.is_empty() {
        "<p class=\"muted\">No validator wallets were recorded for this block.</p>".to_owned()
    } else {
        format!(
            "<div class=\"wallet-list\">{}</div>",
            block
                .miners
                .iter()
                .map(|address| wallet_pill(address))
                .collect::<Vec<_>>()
                .join("")
        )
    };

    Ok(Html(layout(
        &format!("Block #{}", block.block_height),
        &format!(
            r#"
<section class="hero compact-hero">
    <p class="eyebrow">Worker Block</p>
    <h1>Block #{height}</h1>
    <p class="hero-sub muted">This block records worker settlement, validator participation, and all confirmed ANT-denominated transfers included at this height.</p>
    <div class="hero-tags">
        <span class="pill">{block_kind}</span>
        <span class="pill">{activated_supply_anet} ANET ({activated_supply} ANTS) Activated</span>
        <span class="pill">{tx_count} Confirmed Transfers</span>
    </div>
</section>
<section class="card section-surface">
    <div class="section-head"><div><p class="eyebrow">Block Header</p><h2>Overview</h2></div><a class="action-ghost" href="/explorer/blocks">Back to ledger</a></div>
    <div class="details details-strong">
        <div><span>Hash</span><strong class="mono break-anywhere">{hash}</strong></div>
        <div><span>Previous Hash</span><strong class="mono break-anywhere">{previous}</strong></div>
        <div><span>Epoch Start</span><strong class="break-anywhere">{start}</strong></div>
        <div><span>Epoch End</span><strong class="break-anywhere">{end}</strong></div>
        <div><span>Activated Supply</span><strong class="mono break-anywhere">{activated_supply_anet} ANET ({activated_supply} ANTS)</strong></div>
        <div><span>Total Fees</span><strong class="mono break-anywhere">{fees_anet} ANET ({fees} ANTS)</strong></div>
        <div><span>Fee Per Miner</span><strong class="mono break-anywhere">{fee_per_miner_anet} ANET ({fee_per_miner} ANTS)</strong></div>
        <div><span>Worker Validators</span><strong class="mono">{miner_count}</strong></div>
    </div>
</section>
<section class="card section-surface">
    <div class="section-head"><div><p class="eyebrow">Validators</p><h2>Validator Wallets</h2></div><span class="muted">Every validator wallet is linked to its account profile.</span></div>
    {miner_wallets}
</section>
<section class="card section-surface"><div class="section-head"><div><p class="eyebrow">Transfers</p><h2>Worker Transactions</h2></div></div>{transactions}</section>
"#,
            height = block.block_height,
            block_kind = if block.transactions.is_empty() {
                if block.activated_supply_ants > 0 {
                    "Settlement Block"
                } else {
                    "Anchor Block"
                }
            } else if block.activated_supply_ants > 0 {
                "Transfer + Settlement Block"
            } else {
                "Transfer Block"
            },
            activated_supply = format_integer(block.activated_supply_ants),
            activated_supply_anet = state::format_anet_fixed(block.activated_supply_ants),
            tx_count = format_integer(block.transactions.len() as u64),
            hash = block.hash,
            previous = block.previous_hash,
            start = block.epoch_start.to_rfc3339(),
            end = block.epoch_end.to_rfc3339(),
            fees = format_integer(block.total_fees_ants),
            fees_anet = state::format_anet_fixed(block.total_fees_ants),
            fee_per_miner = format_integer(block.fee_per_miner),
            fee_per_miner_anet = state::format_anet_fixed(block.fee_per_miner),
            miner_count = format_integer(block.miners.len() as u64),
            miner_wallets = miner_wallets,
            transactions = transactions,
        ),
    )))
}

async fn explorer_account(
    Path(address): Path<String>,
    AxumState(context): AxumState<RpcContext>,
) -> Result<Html<String>, (StatusCode, Json<ApiError>)> {
    let (onchain, blocks, mempool, summary) = {
        let state = context.state.read().await;
        (
            state.account_view(&address),
            state.all_blocks(),
            state.mempool.clone(),
            state.network_summary(),
        )
    };

    let web2 = try_load_web2_account_fast(&address).await;

    if onchain.is_none() && web2.is_none() {
        return Err(not_found(format!("account {address} not found")));
    }

    let onchain_ants = onchain
        .as_ref()
        .map(|account| account.ants_balance)
        .unwrap_or(0);
    let web2_ants = web2
        .as_ref()
        .map(|account| account.ants_balance)
        .unwrap_or(0);
    let sessions = web2.as_ref().map(|account| account.sessions).unwrap_or(0);
    let status = if onchain.is_some() {
        "ACTIVATED"
    } else {
        "NOT_ACTIVATED"
    };
    let phase = if onchain.is_some() {
        "Activated"
    } else {
        "Colony Phase"
    };
    let pending_label = if onchain.is_some() {
        "Activated"
    } else {
        "Pending Genesis"
    };
    let eligible = web2
        .as_ref()
        .map(|account| yes_no(account.is_eligible))
        .unwrap_or("No");
    let combined_ants = onchain_ants.max(web2_ants);
    let session_ants = sessions.saturating_mul(crate::activation::ANTS_PER_SESSION);
    let mut incoming_transfers = 0_u64;
    let mut outgoing_transfers = 0_u64;
    let mut pending_incoming_transfers = 0_u64;
    let mut pending_outgoing_transfers = 0_u64;
    let mut total_received_ants = 0_u64;
    let mut total_sent_ants = 0_u64;
    let mut total_fees_paid_ants = 0_u64;
    let mut validated_blocks = 0_u64;
    let mut last_activity_at = None;
    let mut incoming_history = Vec::new();
    let mut outgoing_history = Vec::new();
    let mut pending_incoming_history = Vec::new();
    let mut pending_outgoing_history = Vec::new();

    for block in &blocks {
        let mut touched = false;

        if block.miners.iter().any(|miner| miner == &address) {
            validated_blocks = validated_blocks.saturating_add(1);
            touched = true;
        }

        for tx in &block.transactions {
            if tx.from == address {
                outgoing_transfers = outgoing_transfers.saturating_add(1);
                total_sent_ants = total_sent_ants.saturating_add(tx.amount_ants);
                total_fees_paid_ants = total_fees_paid_ants.saturating_add(tx.fee_ants);
                outgoing_history.push(render_transfer_row(
                    tx,
                    block.block_height,
                    &block.epoch_end.to_rfc3339(),
                    false,
                ));
                touched = true;
            }
            if tx.to == address {
                incoming_transfers = incoming_transfers.saturating_add(1);
                total_received_ants = total_received_ants.saturating_add(tx.amount_ants);
                incoming_history.push(render_transfer_row(
                    tx,
                    block.block_height,
                    &block.epoch_end.to_rfc3339(),
                    true,
                ));
                touched = true;
            }
        }

        if touched {
            last_activity_at = Some(block.epoch_end.to_rfc3339());
        }
    }

    for tx in &mempool {
        if tx.from == address {
            pending_outgoing_transfers = pending_outgoing_transfers.saturating_add(1);
            pending_outgoing_history.push(render_pending_transfer_row(tx, false));
        }
        if tx.to == address {
            pending_incoming_transfers = pending_incoming_transfers.saturating_add(1);
            pending_incoming_history.push(render_pending_transfer_row(tx, true));
        }
    }

    let current_role = if onchain
        .as_ref()
        .map(|account| account.is_validator)
        .unwrap_or(false)
    {
        "ACTIVE VALIDATOR"
    } else if web2
        .as_ref()
        .map(|account| account.is_eligible)
        .unwrap_or(false)
    {
        "ELIGIBLE WORKER"
    } else {
        "STANDARD WORKER"
    };
    let last_activity_label =
        last_activity_at.unwrap_or_else(|| "No on-chain activity yet".to_owned());
    let settlement_note = format!(
        "Confirmed transfers appear below only after they are included in a TPoW block. Once a transfer is listed here, it is already credited or debited on-chain. New mempool transfers normally reflect after the next {} block closes at {}.",
        format_transfer_epoch_label(summary.epoch_seconds),
        summary.current_epoch_end.to_rfc3339(),
    );
    let incoming_anchor = if incoming_transfers > 0 {
        "#incoming-transfers"
    } else {
        "#incoming-pending"
    };
    let outgoing_anchor = if outgoing_transfers > 0 {
        "#outgoing-transfers"
    } else {
        "#outgoing-pending"
    };
    let incoming_history_html = render_transfer_history(
        "incoming-transfers",
        "Confirmed Incoming Transfers",
        "Every transfer in this list is already credited to this wallet because it was sealed into a confirmed block.",
        &incoming_history,
        "No confirmed incoming transfers yet.",
    );
    let outgoing_history_html = render_transfer_history(
        "outgoing-transfers",
        "Confirmed Outgoing Transfers",
        "Every transfer in this list is already debited from this wallet because it was sealed into a confirmed block.",
        &outgoing_history,
        "No confirmed outgoing transfers yet.",
    );
    let pending_incoming_html = render_transfer_history(
        "incoming-pending",
        "Pending Incoming Transfers",
        "These transfers are still waiting in the mempool. They are not credited until they appear in a confirmed block.",
        &pending_incoming_history,
        "No pending incoming transfers.",
    );
    let pending_outgoing_html = render_transfer_history(
        "outgoing-pending",
        "Pending Outgoing Transfers",
        "These transfers are still waiting in the mempool. They are not debited until they appear in a confirmed block.",
        &pending_outgoing_history,
        "No pending outgoing transfers.",
    );

    Ok(Html(layout(
        &format!("Account {}", address),
        &format!(
            r#"
<section class="hero compact-hero">
    <p class="eyebrow">Worker Account</p>
    <h1>Account Overview</h1>
    <p class="hero-sub muted break-anywhere">{address}</p>
</section>
<section class="card section-surface">
    <div class="section-head"><div><p class="eyebrow">Worker State</p><h2>Wallet: {address}</h2></div><span class="pill">{status}</span></div>
    <div class="account-actions">
        <a class="action-link" href="/explorer?from={address}">Send From Worker Wallet</a>
        <a class="action-ghost" href="/account/full/{address}">Worker JSON View</a>
    </div>
    <div class="balance-stack">
        <div class="balance-card">
            <span>On-Chain Balance</span>
            <strong class="mono break-anywhere">{onchain_anet} ANET</strong>
        </div>
        <div class="balance-card highlight">
            <span>Session-Based Balance</span>
            <strong class="mono break-anywhere">{web2_anet} ANET ({pending_label})</strong>
        </div>
        <div class="balance-card">
            <span>Combined Footprint</span>
            <strong class="mono break-anywhere">{combined_anet} ANET</strong>
        </div>
    </div>
    <div class="details details-strong">
        <div><span>Work Sessions</span><strong class="mono">{sessions}</strong></div>
        <div><span>Session Reward Base</span><strong class="mono">{session_reward} ANTS</strong></div>
        <div><span>Session-Derived Work</span><strong class="mono">{session_anet} ANET</strong></div>
        <div><span>Phase</span><strong>{phase}</strong></div>
        <div><span>Ledger State</span><strong>{status}</strong></div>
        <div><span>Validator Eligible</span><strong>{eligible}</strong></div>
        <div><span>Current Role</span><strong>{current_role}</strong></div>
    </div>
</section>
<section class="card section-surface">
    <div class="section-head"><div><p class="eyebrow">Chain Activity</p><h2>Wallet Activity Detail</h2></div><span class="muted">Session-derived work, transfer flow, and validator participation for this wallet.</span></div>
    <p class="muted section-note">{settlement_note}</p>
    <div class="details details-strong">
        <div><span>Incoming Transfers</span><strong class="mono"><a class="stat-link" href="{incoming_anchor}">{incoming_transfers}</a></strong></div>
        <div><span>Outgoing Transfers</span><strong class="mono"><a class="stat-link" href="{outgoing_anchor}">{outgoing_transfers}</a></strong></div>
        <div><span>Pending Incoming</span><strong class="mono"><a class="stat-link" href='#incoming-pending'>{pending_incoming_transfers}</a></strong></div>
        <div><span>Pending Outgoing</span><strong class="mono"><a class="stat-link" href='#outgoing-pending'>{pending_outgoing_transfers}</a></strong></div>
        <div><span>Total Received</span><strong class="mono break-anywhere">{received_anet} ANET</strong></div>
        <div><span>Total Sent</span><strong class="mono break-anywhere">{sent_anet} ANET</strong></div>
        <div><span>Total Fees Paid</span><strong class="mono break-anywhere">{fees_anet} ANET</strong></div>
        <div><span>Validated Blocks</span><strong class="mono">{validated_blocks}</strong></div>
        <div><span>Last Chain Activity</span><strong class="mono break-anywhere">{last_activity}</strong></div>
    </div>
</section>
{incoming_history_html}
{outgoing_history_html}
{pending_incoming_html}
{pending_outgoing_html}
"#,
            address = address,
            onchain_anet = state::format_anet_fixed(onchain_ants),
            web2_anet = state::format_anet_fixed(web2_ants),
            combined_anet = state::format_anet_fixed(combined_ants),
            pending_label = pending_label,
            sessions = sessions,
            session_reward = format_integer(crate::activation::ANTS_PER_SESSION),
            session_anet = state::format_anet_fixed(session_ants),
            phase = phase,
            status = status,
            eligible = eligible,
            current_role = current_role,
            settlement_note = settlement_note,
            incoming_anchor = incoming_anchor,
            outgoing_anchor = outgoing_anchor,
            incoming_transfers = format_integer(incoming_transfers),
            outgoing_transfers = format_integer(outgoing_transfers),
            pending_incoming_transfers = format_integer(pending_incoming_transfers),
            pending_outgoing_transfers = format_integer(pending_outgoing_transfers),
            received_anet = state::format_anet_fixed(total_received_ants),
            sent_anet = state::format_anet_fixed(total_sent_ants),
            fees_anet = state::format_anet_fixed(total_fees_paid_ants),
            validated_blocks = format_integer(validated_blocks),
            last_activity = last_activity_label,
            incoming_history_html = incoming_history_html,
            outgoing_history_html = outgoing_history_html,
            pending_incoming_html = pending_incoming_html,
            pending_outgoing_html = pending_outgoing_html,
        ),
    )))
}

fn bad_request(error: impl ToString) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError {
            error: error.to_string(),
        }),
    )
}

fn unauthorized(message: String) -> (StatusCode, Json<ApiError>) {
    (StatusCode::UNAUTHORIZED, Json(ApiError { error: message }))
}

fn not_found(message: String) -> (StatusCode, Json<ApiError>) {
    (StatusCode::NOT_FOUND, Json(ApiError { error: message }))
}

fn service_unavailable(error: impl ToString) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ApiError {
            error: error.to_string(),
        }),
    )
}

fn explorer_db_timeout() -> Duration {
    std::env::var("ANET_EXPLORER_DB_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(1500))
}

fn explorer_dashboard_db_timeout() -> Duration {
    std::env::var("ANET_EXPLORER_DASHBOARD_DB_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| explorer_db_timeout().max(Duration::from_millis(8000)))
}

fn explorer_dashboard_soft_timeout() -> Duration {
    std::env::var("ANET_EXPLORER_DASHBOARD_SOFT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(explorer_db_timeout)
}

fn explorer_dashboard_backoff_duration() -> Duration {
    std::env::var("ANET_EXPLORER_DASHBOARD_BACKOFF_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(10))
}

async fn postgres_ready_fast() -> bool {
    matches!(
        timeout(explorer_db_timeout(), db::connect()).await,
        Ok(Ok(_))
    )
}

async fn load_dashboard_metrics_fast() -> Result<db::DashboardMetrics, (StatusCode, Json<ApiError>)>
{
    let cache_ttl = dashboard_metrics_cache_ttl();
    let cache = dashboard_metrics_cache();
    {
        let cached = cache.read().await;
        if let Some(cached) = cached.as_ref() {
            if cached.cached_at.elapsed() < cache_ttl {
                return Ok(cached.metrics.clone());
            }
        }
    }

    let timeout_window = explorer_dashboard_db_timeout();
    let fresh_metrics = async {
        let client = timeout(timeout_window, db::connect())
            .await
            .map_err(|_| {
                service_unavailable(format!(
                    "postgres connect timed out after {} ms",
                    timeout_window.as_millis()
                ))
            })?
            .map_err(service_unavailable)?;

        timeout(timeout_window, db::load_dashboard_metrics(&client))
            .await
            .map_err(|_| {
                service_unavailable(format!(
                    "postgres metrics query timed out after {} ms",
                    timeout_window.as_millis()
                ))
            })?
            .map_err(service_unavailable)
    }
    .await;

    let metrics = match fresh_metrics {
        Ok(metrics) => metrics,
        Err((status, error)) => {
            let cached = cache.read().await;
            if let Some(cached) = cached.as_ref() {
                tracing::warn!(
                    status = %status,
                    message = %error.error,
                    age_ms = cached.cached_at.elapsed().as_millis(),
                    "serving stale dashboard metrics cache"
                );
                return Ok(cached.metrics.clone());
            }

            return Err((status, error));
        }
    };

    let mut cached = cache.write().await;
    *cached = Some(CachedDashboardMetrics {
        metrics: metrics.clone(),
        cached_at: Instant::now(),
    });

    Ok(metrics)
}

async fn try_load_dashboard_metrics_fast() -> Option<db::DashboardMetrics> {
    if let Some(backoff_until) = dashboard_metrics_backoff_remaining().await {
        if let Some(cached) = read_dashboard_metrics_cache_any_age().await {
            return Some(cached);
        }

        tracing::debug!(
            backoff_remaining_ms = backoff_until.as_millis(),
            "explorer dashboard metrics request skipped during backoff window"
        );
        return None;
    }

    let soft_timeout = explorer_dashboard_soft_timeout();

    match timeout(soft_timeout, load_dashboard_metrics_fast()).await {
        Ok(Ok(metrics)) => {
            clear_dashboard_metrics_backoff().await;
            Some(metrics)
        }
        Ok(Err((status, error))) => {
            activate_dashboard_metrics_backoff().await;
            tracing::warn!(
                status = %status,
                message = %error.error,
                timeout_ms = soft_timeout.as_millis(),
                "explorer dashboard metrics unavailable"
            );
            read_dashboard_metrics_cache_any_age().await
        }
        Err(_) => {
            activate_dashboard_metrics_backoff().await;
            tracing::warn!(
                timeout_ms = soft_timeout.as_millis(),
                "explorer dashboard metrics skipped after soft timeout"
            );
            read_dashboard_metrics_cache_any_age().await
        }
    }
}

async fn read_dashboard_metrics_cache_any_age() -> Option<db::DashboardMetrics> {
    let cache = dashboard_metrics_cache();
    let cached = cache.read().await;
    cached.as_ref().map(|entry| entry.metrics.clone())
}

async fn dashboard_metrics_backoff_remaining() -> Option<Duration> {
    let backoff = dashboard_metrics_backoff();
    let guard = backoff.read().await;
    guard
        .as_ref()
        .and_then(|deadline| deadline.checked_duration_since(Instant::now()))
}

async fn activate_dashboard_metrics_backoff() {
    let mut backoff = dashboard_metrics_backoff().write().await;
    *backoff = Some(Instant::now() + explorer_dashboard_backoff_duration());
}

async fn clear_dashboard_metrics_backoff() {
    let mut backoff = dashboard_metrics_backoff().write().await;
    *backoff = None;
}

async fn load_territory_colony_usage_fast(
    territory: &str,
) -> Result<Vec<db::ColonyGroupUsageRow>, (StatusCode, Json<ApiError>)> {
    let cache_ttl = detail_query_cache_ttl();
    if let Some(cached) =
        read_cached_key(territory_colony_usage_cache(), territory, cache_ttl).await
    {
        return Ok(cached);
    }

    let timeout_window = explorer_db_timeout();
    let client = timeout(timeout_window, db::connect())
        .await
        .map_err(|_| {
            service_unavailable(format!(
                "postgres connect timed out after {} ms",
                timeout_window.as_millis()
            ))
        })?
        .map_err(service_unavailable)?;

    let rows = timeout(
        timeout_window,
        db::load_territory_colony_usage(&client, territory),
    )
    .await
    .map_err(|_| {
        service_unavailable(format!(
            "postgres territory colony query timed out after {} ms",
            timeout_window.as_millis()
        ))
    })?
    .map_err(service_unavailable)?;

    write_cached_key(territory_colony_usage_cache(), territory, rows.clone()).await;
    Ok(rows)
}

async fn load_territory_room_profiles_fast(
    territory: &str,
) -> Result<Vec<db::ColonyRoomProfileRow>, (StatusCode, Json<ApiError>)> {
    let cache_ttl = detail_query_cache_ttl();
    if let Some(cached) =
        read_cached_key(territory_room_profiles_cache(), territory, cache_ttl).await
    {
        return Ok(cached);
    }

    let timeout_window = explorer_db_timeout();
    let client = timeout(timeout_window, db::connect())
        .await
        .map_err(|_| {
            service_unavailable(format!(
                "postgres connect timed out after {} ms",
                timeout_window.as_millis()
            ))
        })?
        .map_err(service_unavailable)?;

    let rows = timeout(
        timeout_window,
        db::load_territory_room_profiles(&client, territory),
    )
    .await
    .map_err(|_| {
        service_unavailable(format!(
            "postgres territory room query timed out after {} ms",
            timeout_window.as_millis()
        ))
    })?
    .map_err(service_unavailable)?;

    write_cached_key(territory_room_profiles_cache(), territory, rows.clone()).await;
    Ok(rows)
}

async fn load_colony_room_profiles_fast(
    colony_label: &str,
) -> Result<Vec<db::ColonyRoomProfileRow>, (StatusCode, Json<ApiError>)> {
    let cache_ttl = detail_query_cache_ttl();
    if let Some(cached) =
        read_cached_key(colony_room_profiles_cache(), colony_label, cache_ttl).await
    {
        return Ok(cached);
    }

    let timeout_window = explorer_db_timeout();
    let client = timeout(timeout_window, db::connect())
        .await
        .map_err(|_| {
            service_unavailable(format!(
                "postgres connect timed out after {} ms",
                timeout_window.as_millis()
            ))
        })?
        .map_err(service_unavailable)?;

    let rows = timeout(
        timeout_window,
        db::load_colony_room_profiles(&client, colony_label),
    )
    .await
    .map_err(|_| {
        service_unavailable(format!(
            "postgres room query timed out after {} ms",
            timeout_window.as_millis()
        ))
    })?
    .map_err(service_unavailable)?;

    write_cached_key(colony_room_profiles_cache(), colony_label, rows.clone()).await;
    Ok(rows)
}

async fn load_colony_room_profile_fast(
    room_key: &str,
) -> Result<Option<db::ColonyRoomProfileRow>, (StatusCode, Json<ApiError>)> {
    let cache_ttl = detail_query_cache_ttl();
    if let Some(cached) = read_cached_key(room_profile_cache(), room_key, cache_ttl).await {
        return Ok(cached);
    }

    let timeout_window = explorer_db_timeout();
    let client = timeout(timeout_window, db::connect())
        .await
        .map_err(|_| {
            service_unavailable(format!(
                "postgres connect timed out after {} ms",
                timeout_window.as_millis()
            ))
        })?
        .map_err(service_unavailable)?;

    let row = timeout(
        timeout_window,
        db::load_colony_room_profile(&client, room_key),
    )
    .await
    .map_err(|_| {
        service_unavailable(format!(
            "postgres room profile query timed out after {} ms",
            timeout_window.as_millis()
        ))
    })?
    .map_err(service_unavailable)?;

    write_cached_key(room_profile_cache(), room_key, row.clone()).await;
    Ok(row)
}

async fn load_web2_account_fast(
    address: &str,
) -> Result<Option<db::Web2AccountRow>, (StatusCode, Json<ApiError>)> {
    let cache_ttl = detail_query_cache_ttl();
    if let Some(cached) = read_cached_key(web2_account_cache(), address, cache_ttl).await {
        return Ok(cached);
    }

    let timeout_window = explorer_db_timeout();
    let client = timeout(timeout_window, db::connect())
        .await
        .map_err(|_| {
            service_unavailable(format!(
                "postgres connect timed out after {} ms",
                timeout_window.as_millis()
            ))
        })?
        .map_err(service_unavailable)?;

    let account = timeout(timeout_window, db::load_web2_account(&client, address))
        .await
        .map_err(|_| {
            service_unavailable(format!(
                "postgres account query timed out after {} ms",
                timeout_window.as_millis()
            ))
        })?
        .map_err(service_unavailable)?;

    write_cached_key(web2_account_cache(), address, account.clone()).await;
    Ok(account)
}

async fn try_load_web2_account_fast(address: &str) -> Option<db::Web2AccountRow> {
    load_web2_account_fast(address).await.ok().flatten()
}

fn dashboard_metrics_cache() -> &'static RwLock<Option<CachedDashboardMetrics>> {
    DASHBOARD_METRICS_CACHE.get_or_init(|| RwLock::new(None))
}

fn dashboard_metrics_backoff() -> &'static RwLock<Option<Instant>> {
    DASHBOARD_METRICS_BACKOFF_UNTIL.get_or_init(|| RwLock::new(None))
}

fn network_stats_snapshot_cache() -> &'static RwLock<Option<CachedNetworkStatsSnapshot>> {
    NETWORK_STATS_SNAPSHOT_CACHE.get_or_init(|| RwLock::new(None))
}

fn explorer_community_snapshot_cache() -> &'static RwLock<Option<CachedExplorerCommunitySnapshot>> {
    EXPLORER_COMMUNITY_SNAPSHOT_CACHE.get_or_init(|| RwLock::new(None))
}

fn dashboard_metrics_cache_ttl() -> Duration {
    std::env::var("ANET_EXPLORER_DASHBOARD_CACHE_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(5))
}

fn detail_query_cache_ttl() -> Duration {
    std::env::var("ANET_EXPLORER_DETAIL_CACHE_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(10))
}

fn network_stats_snapshot_cache_ttl() -> Duration {
    Duration::from_secs(30)
}

fn explorer_community_snapshot_cache_ttl() -> Duration {
    std::env::var("ANET_EXPLORER_COMMUNITY_CACHE_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(30))
}

fn explorer_network_stats_soft_timeout() -> Duration {
    Duration::from_millis(1800)
}

fn explorer_community_soft_timeout() -> Duration {
    std::env::var("ANET_EXPLORER_COMMUNITY_SOFT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| explorer_db_timeout().max(Duration::from_millis(2200)))
}

async fn try_load_network_stats_snapshot_fast() -> Option<db::NetworkStatsSnapshot> {
    let cache_ttl = network_stats_snapshot_cache_ttl();
    {
        let cache = network_stats_snapshot_cache().read().await;
        if let Some(cached) = cache.as_ref() {
            if cached.cached_at.elapsed() < cache_ttl {
                return Some(cached.snapshot.clone());
            }
        }
    }

    let timeout_window = explorer_network_stats_soft_timeout();
    let snapshot = timeout(timeout_window, async {
        let client = db::connect().await.map_err(service_unavailable)?;
        db::load_network_stats_snapshot(client.as_ref())
            .await
            .map_err(service_unavailable)
    })
    .await;

    match snapshot {
        Ok(Ok(snapshot)) => {
            let mut cache = network_stats_snapshot_cache().write().await;
            *cache = Some(CachedNetworkStatsSnapshot {
                snapshot: snapshot.clone(),
                cached_at: Instant::now(),
            });
            Some(snapshot)
        }
        Ok(Err((status, error))) => {
            tracing::warn!(
                status = %status,
                message = %error.error,
                "lightweight network stats snapshot unavailable"
            );
            let cache = network_stats_snapshot_cache().read().await;
            cache.as_ref().map(|cached| cached.snapshot.clone())
        }
        Err(_) => {
            tracing::warn!(
                timeout_ms = timeout_window.as_millis(),
                "lightweight network stats snapshot timed out"
            );
            let cache = network_stats_snapshot_cache().read().await;
            cache.as_ref().map(|cached| cached.snapshot.clone())
        }
    }
}

async fn try_load_explorer_community_snapshot_fast() -> Option<db::ExplorerCommunitySnapshot> {
    let cache_ttl = explorer_community_snapshot_cache_ttl();
    {
        let cache = explorer_community_snapshot_cache().read().await;
        if let Some(cached) = cache.as_ref() {
            if cached.cached_at.elapsed() < cache_ttl {
                return Some(cached.snapshot.clone());
            }
        }
    }

    let timeout_window = explorer_community_soft_timeout();
    let snapshot = timeout(timeout_window, async {
        let client = db::connect().await.map_err(service_unavailable)?;
        db::load_explorer_community_snapshot(client.as_ref())
            .await
            .map_err(service_unavailable)
    })
    .await;

    match snapshot {
        Ok(Ok(snapshot)) => {
            let mut cache = explorer_community_snapshot_cache().write().await;
            *cache = Some(CachedExplorerCommunitySnapshot {
                snapshot: snapshot.clone(),
                cached_at: Instant::now(),
            });
            Some(snapshot)
        }
        Ok(Err((status, error))) => {
            tracing::warn!(
                status = %status,
                message = %error.error,
                "lightweight explorer community snapshot unavailable"
            );
            let cache = explorer_community_snapshot_cache().read().await;
            cache.as_ref().map(|cached| cached.snapshot.clone())
        }
        Err(_) => {
            tracing::warn!(
                timeout_ms = timeout_window.as_millis(),
                "lightweight explorer community snapshot timed out"
            );
            let cache = explorer_community_snapshot_cache().read().await;
            cache.as_ref().map(|cached| cached.snapshot.clone())
        }
    }
}

fn territory_colony_usage_cache(
) -> &'static RwLock<HashMap<String, CachedValue<Vec<db::ColonyGroupUsageRow>>>> {
    TERRITORY_COLONY_USAGE_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn territory_room_profiles_cache(
) -> &'static RwLock<HashMap<String, CachedValue<Vec<db::ColonyRoomProfileRow>>>> {
    TERRITORY_ROOM_PROFILES_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn colony_room_profiles_cache(
) -> &'static RwLock<HashMap<String, CachedValue<Vec<db::ColonyRoomProfileRow>>>> {
    COLONY_ROOM_PROFILES_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn room_profile_cache(
) -> &'static RwLock<HashMap<String, CachedValue<Option<db::ColonyRoomProfileRow>>>> {
    ROOM_PROFILE_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn web2_account_cache() -> &'static RwLock<HashMap<String, CachedValue<Option<db::Web2AccountRow>>>>
{
    WEB2_ACCOUNT_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

async fn read_cached_key<T: Clone>(
    cache: &'static RwLock<HashMap<String, CachedValue<T>>>,
    key: &str,
    ttl: Duration,
) -> Option<T> {
    let cache = cache.read().await;
    cache.get(key).and_then(|cached| {
        if cached.cached_at.elapsed() < ttl {
            Some(cached.value.clone())
        } else {
            None
        }
    })
}

async fn write_cached_key<T: Clone>(
    cache: &'static RwLock<HashMap<String, CachedValue<T>>>,
    key: &str,
    value: T,
) {
    let mut cache = cache.write().await;
    cache.insert(
        key.to_owned(),
        CachedValue {
            value,
            cached_at: Instant::now(),
        },
    );
}

fn cache_control_header(value: &'static str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static(value));
    headers
}

fn layout(title: &str, body: &str) -> String {
    format!(
        "<!DOCTYPE html>
<html lang=\"en\">
<head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>{title}</title>
    <link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%2322e7b8'/%3E%3Cstop offset='100%25' stop-color='%2358c5ff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='18' fill='%23050b12'/%3E%3Crect x='4' y='4' width='56' height='56' rx='16' fill='url(%23g)' fill-opacity='0.18' stroke='url(%23g)' stroke-width='2'/%3E%3Ctext x='50%25' y='52%25' dominant-baseline='middle' text-anchor='middle' font-family='Orbitron,Arial,sans-serif' font-size='24' font-weight='800' fill='%23eff6ff'%3EAN%3C/text%3E%3C/svg%3E\" />
    <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />
    <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />
    <link href=\"https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;800&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap\" rel=\"stylesheet\" />
    <link rel=\"stylesheet\" href=\"/explorer/assets/explorer.css\" />
</head>
<body>
    <div class=\"bg-orb\"></div>
    <div class=\"bg-orb-two\"></div>
    <div class=\"bg-grid\"></div>
    <div class=\"viewport\">
        <aside class=\"sidebar\">
            <div class=\"brand-stack\">
                <div class=\"brand-mark\">AN</div>
                <div class=\"brand-copy\">
                    <strong>A-Network</strong>
                    <span>Ant colony explorer</span>
                </div>
            </div>
            <div class=\"sidebar-section\">
                <p class=\"sidebar-label\">Navigation</p>
                <div class=\"sidebar-nav\">
                    <a class=\"sidebar-link {dashboard_sidebar_class}\" href=\"/explorer\"><span>Colony Overview</span><span>Live</span></a>
                    <a class=\"sidebar-link {miners_sidebar_class}\" href=\"/explorer/miners\"><span>Miner Portal</span><span>Private</span></a>
                    <a class=\"sidebar-link {build_sidebar_class}\" href=\"/explorer/build\"><span>Builder Portal</span><span>ANET</span></a>
                    <a class=\"sidebar-link {blocks_sidebar_class}\" href=\"/explorer/blocks\"><span>Ant Ledger</span><span>Chain</span></a>
                    <a class=\"sidebar-link {api_sidebar_class}\" href=\"/explorer/api\"><span>Ledger API</span><span>Portal</span></a>
                    <a class=\"sidebar-link {health_sidebar_class}\" href=\"/explorer/health\"><span>Colony Health</span><span>Monitor</span></a>
                </div>
            </div>
            <div class=\"sidebar-section\">
                <p class=\"sidebar-label\">Overview</p>
                <div class=\"sidebar-note\">
                    <strong>ANET Layer 1 Private Mainnet</strong>
                    This explorer tracks the private-mainnet Ant Ledger in real time, then layers private miner and builder access on top without splitting the codebase yet.
                </div>
            </div>
        </aside>
        <main class=\"shell\">
            <nav class=\"nav\">
                <a class=\"{dashboard_nav_class}\" href=\"/explorer\">Overview</a>
                <a class=\"{miners_nav_class}\" href=\"/explorer/miners\">Miners</a>
                <a class=\"{build_nav_class}\" href=\"/explorer/build\">Build</a>
                <a class=\"{blocks_nav_class}\" href=\"/explorer/blocks\">Ant Ledger</a>
                <a class=\"{api_nav_class}\" href=\"/explorer/api\">API</a>
                <a class=\"{health_nav_class}\" href=\"/explorer/health\">Health</a>
                <a href=\"/explorer/search?q=1\">Search</a>
            </nav>
            {body}
        </main>
    </div>
</body>
</html>",
        title = title,
        body = body,
        dashboard_sidebar_class = nav_class(title == "Explorer Dashboard"),
        miners_sidebar_class = nav_class(title == "Explorer Miners"),
        build_sidebar_class = nav_class(title == "Explorer Build"),
        blocks_sidebar_class = nav_class(title == "Explorer Blocks" || title.starts_with("Block #")),
        api_sidebar_class = nav_class(title == "Explorer API"),
        health_sidebar_class = nav_class(title == "Explorer Health"),
        dashboard_nav_class = nav_class(title == "Explorer Dashboard"),
        miners_nav_class = nav_class(title == "Explorer Miners"),
        build_nav_class = nav_class(title == "Explorer Build"),
        blocks_nav_class = nav_class(title == "Explorer Blocks" || title.starts_with("Block #")),
        api_nav_class = nav_class(title == "Explorer API"),
        health_nav_class = nav_class(title == "Explorer Health"),
    )
}

fn pretty_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_owned())
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn block_link(height: u64) -> String {
    format!(
        "<a class=\"address-link mono\" href=\"/explorer/blocks/{height}\">Block #{height}</a>",
        height = height,
    )
}

fn render_transfer_row(
    tx: &crate::transaction::Transaction,
    block_height: u64,
    settled_at: &str,
    incoming: bool,
) -> String {
    let counterparty = if incoming { &tx.from } else { &tx.to };
    let direction = if incoming { "Credited" } else { "Debited" };
    let fee_label = if incoming {
        "Fee paid by sender".to_owned()
    } else {
        format!("Fee {} ANTS", tx.fee_ants)
    };
    let memo_html = if tx.memo.trim().is_empty() {
        "<span class=\"muted\">No memo</span>".to_owned()
    } else {
        format!(
            "<span class=\"tx-memo\">Memo: {}</span>",
            escape_html(&tx.memo)
        )
    };

    format!(
        "<div class=\"tx-row\"><strong>{direction}</strong><span>{amount} ANTS</span><strong>{counterparty}</strong><span>{fee}</span><span class=\"tx-status confirmed\">{block}</span><span class=\"mono\">{settled_at}</span>{memo}</div>",
        direction = direction,
        amount = format_integer(tx.amount_ants),
        counterparty = wallet_link(counterparty),
        fee = fee_label,
        block = block_link(block_height),
        settled_at = escape_html(settled_at),
        memo = memo_html,
    )
}

fn render_pending_transfer_row(tx: &crate::transaction::Transaction, incoming: bool) -> String {
    let counterparty = if incoming { &tx.from } else { &tx.to };
    let direction = if incoming {
        "Awaiting Credit"
    } else {
        "Awaiting Debit"
    };
    let fee_label = if incoming {
        "Fee paid by sender".to_owned()
    } else {
        format!("Fee {} ANTS", tx.fee_ants)
    };
    let memo_html = if tx.memo.trim().is_empty() {
        "<span class=\"muted\">No memo</span>".to_owned()
    } else {
        format!(
            "<span class=\"tx-memo\">Memo: {}</span>",
            escape_html(&tx.memo)
        )
    };

    format!(
        "<div class=\"tx-row\"><strong>{direction}</strong><span>{amount} ANTS</span><strong>{counterparty}</strong><span>{fee}</span><span class=\"tx-status pending\">Pending in mempool</span><span class=\"mono\">Queued {queued_at}</span>{memo}</div>",
        direction = direction,
        amount = format_integer(tx.amount_ants),
        counterparty = wallet_link(counterparty),
        fee = fee_label,
        queued_at = escape_html(&tx.timestamp.to_rfc3339()),
        memo = memo_html,
    )
}

fn render_transfer_history(
    section_id: &str,
    title: &str,
    note: &str,
    rows: &[String],
    empty_message: &str,
) -> String {
    let content = if rows.is_empty() {
        format!("<p class=\"muted\">{}</p>", empty_message)
    } else {
        format!("<div class=\"list\">{}</div>", rows.join(""))
    };

    format!(
        "<section id=\"{section_id}\" class=\"card section-surface\"><div class=\"section-head\"><div><p class=\"eyebrow\">Transfer History</p><h2>{title}</h2></div></div><p class=\"muted section-note\">{note}</p>{content}</section>",
        section_id = section_id,
        title = title,
        note = note,
        content = content,
    )
}

fn wallet_link(address: &str) -> String {
    format!(
        "<a class=\"address-link mono break-anywhere\" href=\"/explorer/accounts/{address}\">{address}</a>",
        address = address,
    )
}

fn wallet_pill(address: &str) -> String {
    format!(
        "<a class=\"wallet-pill mono break-anywhere\" href=\"/explorer/accounts/{address}\">{address}</a>",
        address = address,
    )
}

fn request_prefers_html(headers: &HeaderMap) -> bool {
    headers
        .get(ACCEPT)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("text/html"))
        .unwrap_or(false)
}

fn explorer_auth_required() -> bool {
    std::env::var("ANET_EXPLORER_AUTH_REQUIRED")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .map(|value| !matches!(value.as_str(), "0" | "false" | "off" | "no"))
        .unwrap_or(false)
}

fn allow_ineligible_wallet_test_mode() -> bool {
    std::env::var("ANET_ALLOW_INELIGIBLE_WALLET_TEST")
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on"
        })
        .unwrap_or(false)
}

fn explorer_auth_secret() -> Option<String> {
    std::env::var("ANET_EXPLORER_AUTH_SECRET")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn explorer_wallet_session_ttl_seconds() -> u64 {
    std::env::var("ANET_EXPLORER_AUTH_TTL_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(43_200)
}

fn unix_now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn sign_wallet_session(wallet: &str, expires_at: u64, secret: &str) -> String {
    let payload = format!("{wallet}:{expires_at}:{secret}");
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    hex::encode(hasher.finalize())
}

fn build_wallet_session_cookie(wallet: &str) -> String {
    let secret = explorer_auth_secret().unwrap_or_default();
    let expires_at = unix_now_seconds().saturating_add(explorer_wallet_session_ttl_seconds());
    let signature = sign_wallet_session(wallet, expires_at, &secret);
    let value = format!("{wallet}.{expires_at}.{signature}");
    format!(
        "{cookie_name}={value}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax",
        cookie_name = EXPLORER_AUTH_COOKIE,
        value = value,
        max_age = explorer_wallet_session_ttl_seconds(),
    )
}

fn extract_cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookie_header| {
            cookie_header.split(';').map(str::trim).find_map(|pair| {
                let mut parts = pair.splitn(2, '=');
                let key = parts.next()?.trim();
                let value = parts.next()?.trim();
                if key == name {
                    Some(value.to_owned())
                } else {
                    None
                }
            })
        })
}

fn authenticated_wallet_from_headers(headers: &HeaderMap) -> Option<String> {
    if !explorer_auth_required() {
        return None;
    }

    let secret = explorer_auth_secret()?;
    let raw = extract_cookie_value(headers, EXPLORER_AUTH_COOKIE)?;
    let mut parts = raw.splitn(3, '.');
    let wallet = parts.next()?.trim().to_uppercase();
    let expires_at = parts.next()?.trim().parse::<u64>().ok()?;
    let signature = parts.next()?.trim().to_owned();

    if wallet.is_empty() || expires_at <= unix_now_seconds() {
        return None;
    }

    let expected = sign_wallet_session(&wallet, expires_at, &secret);
    if expected != signature {
        return None;
    }

    Some(wallet)
}

fn sanitize_explorer_next_path(next: Option<&str>) -> String {
    let next = next.unwrap_or("/explorer").trim();
    if next.starts_with("/explorer") {
        next.to_owned()
    } else {
        "/explorer".to_owned()
    }
}

fn render_explorer_login_page(error: Option<&str>, next: &str) -> String {
    let error_html = error
        .map(|message| {
            format!(
                "<div class=\"tx-result error\" style=\"margin-top:0;\">{}</div>",
                escape_html(message)
            )
        })
        .unwrap_or_default();

    let body = format!(
        r#"
<section class="hero compact-hero">
    <p class="eyebrow">Wallet Access</p>
    <h1>Explorer Wallet Login</h1>
    <p class="hero-sub muted">This explorer is restricted to in-app ANET wallets. Sign in with your wallet and seed phrase, then transfer in ANET display units while chain settlement remains exact in ANTS.</p>
</section>
<section class="card section-surface">
    {error_html}
    <form class="tx-form" action="/explorer/login" method="post">
        <label><span>ANET Wallet</span><input name="wallet" placeholder="ANET..." required /></label>
        <label><span>Seed Phrase</span><input name="seed_phrase" type="password" placeholder="12-word wallet seed" required /></label>
        <input type="hidden" name="next" value="{next}" />
        <button type="submit">Login To Explorer</button>
    </form>
    <p class="muted" style="margin-top:14px;">Transfer policy remains unchanged: sender and recipient must each be eligible with at least 1,000 sessions.</p>
</section>
"#,
        error_html = error_html,
        next = escape_html(next),
    );

    layout("Explorer Wallet Login", &body)
}

fn explorer_room_bot_guard_enabled() -> bool {
    std::env::var("ANET_EXPLORER_ROOM_BOT_GUARD")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .map(|value| !matches!(value.as_str(), "0" | "false" | "off" | "no"))
        .unwrap_or(true)
}

fn is_probable_room_scan_key(room_key: &str) -> bool {
    room_key
        .strip_prefix("referral-room-")
        .map(|suffix| suffix.len() >= 3 && suffix.chars().all(|ch| ch.is_ascii_digit()))
        .unwrap_or(false)
}

fn is_known_aggressive_crawler(user_agent: &str) -> bool {
    let ua = user_agent.to_ascii_lowercase();
    ua.contains("mj12bot")
        || ua.contains("ahrefsbot")
        || ua.contains("semrushbot")
        || ua.contains("dotbot")
        || ua.contains("bytespider")
        || ua.contains("petalbot")
}

fn should_short_circuit_room_bot_scan(headers: &HeaderMap, room_key: &str) -> bool {
    if !explorer_room_bot_guard_enabled() || !is_probable_room_scan_key(room_key) {
        return false;
    }

    headers
        .get(USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(is_known_aggressive_crawler)
        .unwrap_or(false)
}

fn nav_class(active: bool) -> &'static str {
    if active {
        "active"
    } else {
        ""
    }
}

fn seconds_to_countdown(seconds: i64) -> String {
    let safe = seconds.max(0);
    let hours = safe / 3600;
    let minutes = (safe % 3600) / 60;
    let seconds = safe % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

fn format_transfer_epoch_label(epoch_seconds: u64) -> String {
    if epoch_seconds == 1 {
        return "1s Settlement Window".to_owned();
    }

    if epoch_seconds < 60 {
        return format!("{epoch_seconds}s Settlement Window");
    }

    if epoch_seconds == 60 {
        return "1m Settlement Window".to_owned();
    }

    if epoch_seconds < 3600 {
        return format!("{}m Settlement Window", epoch_seconds / 60);
    }

    if epoch_seconds == crate::consensus::DEFAULT_WORKER_SESSION_SECONDS {
        return "6h Settlement Window".to_owned();
    }

    format!("{}h Settlement Window", epoch_seconds / 3600)
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "Yes"
    } else {
        "No"
    }
}

fn format_integer(value: u64) -> String {
    let digits = value.to_string();
    let mut formatted = String::with_capacity(digits.len() + digits.len() / 3);

    for (index, ch) in digits.chars().rev().enumerate() {
        if index != 0 && index % 3 == 0 {
            formatted.push(',');
        }
        formatted.push(ch);
    }

    formatted.chars().rev().collect()
}

fn format_anet_display(ants: u64) -> String {
    const ANTS_PER_ANET: u64 = 100_000_000;

    let whole = ants / ANTS_PER_ANET;
    let fraction = ants % ANTS_PER_ANET;

    if fraction == 0 {
        return format_integer(whole);
    }

    let mut fraction_text = format!("{fraction:08}");
    while fraction_text.ends_with('0') {
        fraction_text.pop();
    }

    format!("{}.{}", format_integer(whole), fraction_text)
}

fn format_percent(value: f64) -> String {
    format!("{:.2}%", value.clamp(0.0, 100.0))
}

fn percentage(value: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (value as f64 / total as f64) * 100.0
    }
}

fn colony_slug(label: &str) -> String {
    let mut slug = String::new();
    let mut previous_was_dash = false;

    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            previous_was_dash = false;
        } else if !previous_was_dash {
            slug.push('-');
            previous_was_dash = true;
        }
    }

    slug.trim_matches('-').to_owned()
}

fn territory_slug(label: &str) -> String {
    colony_slug(label)
}

fn preferred_colony_labels() -> [&'static str; 7] {
    [
        "Worker Ants",
        "Queen Ant",
        "Nurse Ants",
        "Farmer Ants",
        "Builder Ants",
        "Scout Ants",
        "Soldier Ants",
    ]
}
