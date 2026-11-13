import hashlib
import re
from datetime import date, datetime
from io import BytesIO, StringIO
from zipfile import BadZipFile

import numpy as np
import pandas as pd
import plotly.express as px
import streamlit as st


st.set_page_config(
    page_title="Smart Data Quality Inspector",
    page_icon="📊",
    layout="wide",
)

EMAIL_PATTERN = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"
)
DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%m/%d/%Y",
    "%d/%m/%Y",
    "%m-%d-%Y",
    "%d-%m-%Y",
    "%Y-%m-%d %H:%M:%S",
    "%Y/%m/%d %H:%M:%S",
    "%b %d, %Y",
    "%B %d, %Y",
)
DATE_SHAPES = (
    (re.compile(r"^\d{4}-\d{1,2}-\d{1,2}(?:\s+.*)?$"), "YYYY-MM-DD"),
    (re.compile(r"^\d{4}/\d{1,2}/\d{1,2}(?:\s+.*)?$"), "YYYY/MM/DD"),
    (re.compile(r"^\d{1,2}/\d{1,2}/\d{4}(?:\s+.*)?$"), "slash date"),
    (re.compile(r"^\d{1,2}-\d{1,2}-\d{4}(?:\s+.*)?$"), "hyphen date"),
    (re.compile(r"^[A-Za-z]+\s+\d{1,2},\s*\d{4}$"), "month name"),
)
ISSUE_COLUMNS = [
    "Row Number",
    "Column Name",
    "Issue Type",
    "Current Value",
    "Suggested Fix",
]


def make_sample_data():
    rng = np.random.default_rng(42)
    row_count = 50
    data = pd.DataFrame(
        {
            "customer_id": np.arange(1001, 1001 + row_count),
            "name": [f"Customer {number:02d}" for number in range(1, row_count + 1)],
            "email": [f"customer{number:02d}@example.com" for number in range(1, row_count + 1)],
            "signup_date": [
                (date(2024, 1, 1) + pd.Timedelta(days=int(offset))).strftime("%Y-%m-%d")
                for offset in rng.integers(0, 300, size=row_count)
            ],
            "age": rng.integers(19, 71, size=row_count),
            "annual_spend": np.round(rng.normal(2400, 650, size=row_count), 2),
        }
    )
    data.loc[3, "email"] = "not-an-email"
    data.loc[8, "email"] = "missing.domain@"
    data.loc[12, "signup_date"] = "03/18/2024"
    data.loc[19, "signup_date"] = "not-a-date"
    data.loc[7, "name"] = None
    data.loc[15, "annual_spend"] = np.nan
    data.loc[24, "email"] = ""
    data.loc[32, "name"] = "   "
    data.loc[38, "annual_spend"] = 25000
    data.loc[49] = data.loc[4]
    return data


def is_missing(value):
    if isinstance(value, str):
        return value.strip() == ""
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def display_value(value):
    if is_missing(value):
        return "(empty)"
    return str(value)


def parse_date(value):
    if isinstance(value, (pd.Timestamp, datetime, date, np.datetime64)):
        return True
    if not isinstance(value, str):
        return False
    candidate = value.strip()
    if not candidate:
        return True
    for date_format in DATE_FORMATS:
        try:
            datetime.strptime(candidate, date_format)
            return True
        except ValueError:
            continue
    return False


def date_shape(value):
    for pattern, shape in DATE_SHAPES:
        if pattern.fullmatch(value.strip()):
            return shape
    return "other"


def scan_data(
    data,
    email_columns=None,
    date_columns=None,
    numeric_columns=None,
    iqr_multiplier=1.5,
):
    issues = []
    duplicate_mask = data.duplicated(keep="first")
    email_columns = (
        set(email_columns)
        if email_columns is not None
        else {column for column in data.columns if "email" in str(column).lower()}
    )
    date_columns = (
        set(date_columns)
        if date_columns is not None
        else {column for column in data.columns if "date" in str(column).lower()}
    )
    numeric_columns = (
        set(numeric_columns)
        if numeric_columns is not None
        else {
            column
            for column in data.columns
            if pd.api.types.is_numeric_dtype(data[column])
            and not pd.api.types.is_bool_dtype(data[column])
        }
    )

    def add_issue(row_number, column, issue_type, value, suggestion):
        issues.append(
            {
                "Row Number": row_number,
                "Column Name": column,
                "Issue Type": issue_type,
                "Current Value": display_value(value),
                "Suggested Fix": suggestion,
            }
        )

    for column in data.columns:
        series = data[column]
        for position, value in enumerate(series):
            if is_missing(value):
                add_issue(
                    position + 1,
                    column,
                    "Missing Value",
                    value,
                    "Provide a value or fill using an appropriate default.",
                )

        if column in email_columns:
            for position, value in enumerate(series):
                if is_missing(value):
                    continue
                if not EMAIL_PATTERN.fullmatch(str(value).strip()):
                    add_issue(
                        position + 1,
                        column,
                        "Invalid Email",
                        value,
                        "Correct the address to a valid name@domain format.",
                    )

        if column in date_columns:
            valid_string_shapes = []
            for value in series:
                if isinstance(value, str) and value.strip() and parse_date(value):
                    valid_string_shapes.append(date_shape(value))
            shape_counts = pd.Series(valid_string_shapes).value_counts()
            common_shape = shape_counts.index[0] if not shape_counts.empty else None

            for position, value in enumerate(series):
                if is_missing(value):
                    continue
                if not parse_date(value):
                    add_issue(
                        position + 1,
                        column,
                        "Invalid Date",
                        value,
                        "Replace with a valid date, such as YYYY-MM-DD.",
                    )
                elif (
                    isinstance(value, str)
                    and value.strip()
                    and common_shape is not None
                    and date_shape(value) != common_shape
                ):
                    add_issue(
                        position + 1,
                        column,
                        "Inconsistent Date Format",
                        value,
                        f"Standardize to the most common format ({common_shape}).",
                    )

        if column in numeric_columns:
            numeric_series = pd.to_numeric(series, errors="coerce")
            numeric_values = numeric_series.dropna()
            if not numeric_values.empty:
                first_quartile = numeric_values.quantile(0.25)
                third_quartile = numeric_values.quantile(0.75)
                spread = third_quartile - first_quartile
                lower_bound = first_quartile - iqr_multiplier * spread
                upper_bound = third_quartile + iqr_multiplier * spread
                for position, value in enumerate(numeric_series):
                    if is_missing(value):
                        continue
                    if value < lower_bound or value > upper_bound:
                        add_issue(
                            position + 1,
                            column,
                            "Numeric Outlier",
                            series.iloc[position],
                            "Review this value; confirm it or replace with a validated value.",
                        )

    for position in np.flatnonzero(duplicate_mask.to_numpy()):
        add_issue(
            int(position) + 1,
            "Entire row",
            "Duplicate Row",
            "Exact match to an earlier row",
            "Remove the duplicate row and keep the first occurrence.",
        )

    return pd.DataFrame(issues, columns=ISSUE_COLUMNS), int(duplicate_mask.sum())


def clean_data(data):
    cleaned = data.drop_duplicates().copy()
    for column in cleaned.columns:
        if cleaned[column].dtype == object or pd.api.types.is_string_dtype(cleaned[column]):
            cleaned[column] = cleaned[column].map(
                lambda value: value.strip() if isinstance(value, str) else value
            )
        if pd.api.types.is_numeric_dtype(cleaned[column]) and not pd.api.types.is_bool_dtype(
            cleaned[column]
        ):
            median = cleaned[column].median()
            if pd.notna(median):
                if pd.api.types.is_integer_dtype(cleaned[column]) and median % 1:
                    cleaned[column] = cleaned[column].astype("float64").fillna(median)
                else:
                    cleaned[column] = cleaned[column].fillna(median)
    return cleaned


def read_uploaded_file(uploaded_file):
    content = uploaded_file.getvalue()
    if uploaded_file.name.lower().endswith(".csv"):
        return pd.read_csv(StringIO(content.decode("utf-8-sig")))
    return pd.read_excel(BytesIO(content), engine="openpyxl")


def upload_signature(uploaded_file):
    content = uploaded_file.getvalue()
    return uploaded_file.name, len(content), hashlib.sha256(content).hexdigest()


def load_sample_data():
    st.session_state["inspector_data"] = make_sample_data()
    st.session_state["inspector_source"] = "Sample messy dataset"
    uploaded_file = st.session_state.get("data_upload")
    st.session_state["inspector_ignored_upload"] = (
        upload_signature(uploaded_file) if uploaded_file is not None else None
    )


st.markdown(
    """
    <style>
    :root {
        --ink: #172b3a;
        --muted: #647789;
        --line: #e3eaf0;
        --teal: #087e83;
        --teal-dark: #09666d;
        --canvas: #f7f9fa;
        --panel: #ffffff;
    }
    .stApp, [data-testid="stAppViewContainer"] {background: var(--canvas);}
    [data-testid="stHeader"] {background: rgba(247, 249, 250, 0.88);}
    .block-container {padding-top: 2.25rem; padding-bottom: 3.5rem; max-width: 1480px;}
    h1, h2, h3, [data-testid="stMarkdownContainer"] p {color: var(--ink);}
    .brand-header {
        display: flex; align-items: center; gap: 18px; margin-bottom: 1.65rem;
        padding: 22px 26px; border: 1px solid #e6edf0; border-radius: 22px;
        background:
            radial-gradient(ellipse at 92% 10%, rgba(201, 233, 228, .42), transparent 34%),
            linear-gradient(120deg, #fff 0%, #fbfdfd 68%, #f1f8f6 100%);
        box-shadow: 0 8px 28px rgba(27, 57, 70, .045);
    }
    .brand-logo {width: 58px; height: 58px; flex: 0 0 58px;}
    .brand-eyebrow {
        color: var(--teal); font-size: .72rem; font-weight: 750;
        letter-spacing: .16em; text-transform: uppercase; margin-bottom: 5px;
    }
    .brand-title {
        color: var(--ink); font-size: clamp(1.55rem, 3vw, 2rem);
        line-height: 1.15; font-weight: 760; letter-spacing: -.045em;
    }
    .brand-subtitle {color: var(--muted); font-size: .97rem; margin-top: 6px;}
    .sidebar-brand {
        display: flex; align-items: center; gap: 12px;
        padding: 5px 0 18px; margin-bottom: 8px;
        border-bottom: 1px solid var(--line);
    }
    .sidebar-brand .brand-logo {width: 42px; height: 42px; flex-basis: 42px;}
    .sidebar-brand-title {color: var(--ink); font-size: 1.03rem; font-weight: 730;}
    .sidebar-brand-caption {
        color: var(--muted); font-size: .72rem; margin-top: 2px;
        letter-spacing: .045em; text-transform: uppercase;
    }
    section[data-testid="stSidebar"] {
        background: #f1f5f6; border-right: 1px solid var(--line);
    }
    section[data-testid="stSidebar"] [data-testid="stMarkdownContainer"] p {
        color: var(--muted);
    }
    [data-testid="stMetric"] {
        background: var(--panel); border: 1px solid var(--line);
        padding: 19px 21px; border-radius: 17px;
        box-shadow: 0 5px 18px rgba(27, 57, 70, .045);
    }
    [data-testid="stMetricLabel"] {color: var(--muted); font-size: .88rem;}
    [data-testid="stMetricValue"] {color: var(--ink); font-weight: 730;}
    .st-key-metric_cards [data-testid="stButton"] > button {
        min-height: 8rem; height: 100%; padding: 18px 20px;
        color: var(--ink); background: var(--panel); border: 1px solid var(--line);
        border-radius: 17px; box-shadow: 0 5px 18px rgba(27, 57, 70, .045);
        text-align: left; white-space: pre-line;
    }
    .st-key-metric_cards [data-testid="stButton"] > button p {
        color: var(--ink); text-align: left; line-height: 1.6;
    }
    .st-key-metric_cards [data-testid="stButton"] > button:hover {
        color: var(--teal-dark); background: #f5fbfa; border-color: var(--teal);
        box-shadow: 0 8px 24px rgba(8, 126, 131, .11); transform: translateY(-2px);
    }
    .st-key-metric_cards [data-testid="stButton"] > button:focus:not(:active) {
        border-color: var(--teal); color: var(--teal-dark);
    }
    [data-testid="stTabs"] [role="tablist"] {
        gap: 7px; border-bottom: 1px solid var(--line);
    }
    [data-testid="stTabs"] button[role="tab"] {
        color: var(--muted); font-weight: 620; border-radius: 10px 10px 0 0;
    }
    [data-testid="stTabs"] button[role="tab"][aria-selected="true"] {
        color: var(--teal-dark); border-bottom-color: var(--teal);
    }
    .stButton > button, .stDownloadButton > button {
        min-height: 2.7rem; border-radius: 11px; font-weight: 650;
        border-color: #cfdddd; transition: all .16s ease;
    }
    .stButton > button[kind="primary"], .stDownloadButton > button[kind="primary"] {
        color: white; background: var(--teal); border-color: var(--teal);
    }
    .stButton > button:hover, .stDownloadButton > button:hover {
        color: var(--teal-dark); border-color: var(--teal);
        transform: translateY(-1px);
    }
    [data-testid="stFileUploader"] section {
        border-radius: 13px; border-color: #cfdddd; background: rgba(255,255,255,.72);
    }
    [data-testid="stExpander"] {
        border-color: var(--line); border-radius: 13px; background: rgba(255,255,255,.62);
    }
    [data-testid="stDataFrame"] {
        border: 1px solid var(--line); border-radius: 13px; overflow: hidden;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

def brand_logo(variant):
    gradient_id = f"brand-gradient-{variant}"
    return (
        f'<svg class="brand-logo" viewBox="0 0 64 64" fill="none" '
        f'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
        f'<defs><linearGradient id="{gradient_id}" x1="7" y1="5" x2="58" y2="59" '
        f'gradientUnits="userSpaceOnUse"><stop stop-color="#16A6A0"/>'
        f'<stop offset="1" stop-color="#075B68"/></linearGradient></defs>'
        f'<rect x="2" y="2" width="60" height="60" rx="19" fill="url(#{gradient_id})"/>'
        f'<path d="M17 43V33.5C17 32.67 17.67 32 18.5 32H23.5C24.33 32 25 32.67 '
        f'25 33.5V43" stroke="white" stroke-width="3.5" stroke-linecap="round"/>'
        f'<path d="M29.5 43V25.5C29.5 24.67 30.17 24 31 24H36C36.83 24 37.5 24.67 '
        f'37.5 25.5V43" stroke="white" stroke-width="3.5" stroke-linecap="round"/>'
        f'<path d="M17 48H37.5" stroke="white" stroke-width="3.5" stroke-linecap="round"/>'
        f'<circle cx="45" cy="42" r="10" fill="#D9F5E9" stroke="white" stroke-width="2.5"/>'
        f'<path d="M40.5 42L43.5 45L49.5 38.5" stroke="#087A69" stroke-width="2.8" '
        f'stroke-linecap="round" stroke-linejoin="round"/></svg>'
    )

st.markdown(
    f'<div class="brand-header">{brand_logo("header")}<div>'
    f'<div class="brand-eyebrow">Data quality workspace</div>'
    f'<div class="brand-title">Smart Data Quality Inspector</div>'
    f'<div class="brand-subtitle">A clearer view of your data. Practical fixes for what needs attention.</div>'
    f'</div></div>',
    unsafe_allow_html=True,
)

with st.sidebar:
    st.markdown(
        f'<div class="sidebar-brand">{brand_logo("sidebar")}<div>'
        f'<div class="sidebar-brand-title">Data Inspector</div>'
        f'<div class="sidebar-brand-caption">Quality workspace</div>'
        f'</div></div>',
        unsafe_allow_html=True,
    )
    st.caption("Upload a dataset or explore the built-in sample.")
    uploaded_file = st.file_uploader(
        "Upload a data file",
        type=["csv", "xlsx"],
        help="Supported formats: CSV and Excel (.xlsx).",
        key="data_upload",
    )
    st.button(
        "Load Sample Messy Dataset",
        use_container_width=True,
        on_click=load_sample_data,
    )

if uploaded_file is None:
    st.session_state.pop("inspector_ignored_upload", None)
elif upload_signature(uploaded_file) != st.session_state.get("inspector_ignored_upload"):
    try:
        st.session_state["inspector_data"] = read_uploaded_file(uploaded_file)
        st.session_state["inspector_source"] = uploaded_file.name
        st.session_state["inspector_ignored_upload"] = None
    except (
        BadZipFile,
        UnicodeDecodeError,
        pd.errors.EmptyDataError,
        pd.errors.ParserError,
        ValueError,
        OSError,
    ) as error:
        st.error(f"Could not read {uploaded_file.name}: {error}")
        st.stop()
    except ImportError as error:
        st.error(f"Could not read the Excel file because a required dependency is unavailable: {error}")
        st.stop()

data = st.session_state.get("inspector_data")
if data is None:
    st.info("Upload a CSV or XLSX file, or select **Load Sample Messy Dataset** in the sidebar to get started.")
    st.stop()
if data.empty or len(data.columns) == 0:
    st.warning("The selected dataset has no rows or columns to inspect.")
    st.stop()

columns = list(data.columns)
column_signature = hashlib.sha256(
    "\0".join(map(str, columns)).encode("utf-8")
).hexdigest()[:12]
email_defaults = [column for column in columns if "email" in str(column).lower()]
date_defaults = [column for column in columns if "date" in str(column).lower()]
numeric_defaults = [
    column
    for column in columns
    if pd.api.types.is_numeric_dtype(data[column])
    and not pd.api.types.is_bool_dtype(data[column])
]

with st.sidebar:
    with st.expander("Column Rules", expanded=False):
        email_columns = st.multiselect(
            "Treat columns as Email",
            options=columns,
            default=email_defaults,
            key=f"rule_email_columns_{column_signature}",
            help="Selected columns are checked for valid email addresses.",
        )
        date_columns = st.multiselect(
            "Treat columns as Date",
            options=columns,
            default=date_defaults,
            key=f"rule_date_columns_{column_signature}",
            help="Selected columns are checked for valid and consistent date formats.",
        )
        numeric_columns = st.multiselect(
            "Treat columns as Numeric",
            options=columns,
            default=numeric_defaults,
            key=f"rule_numeric_columns_{column_signature}",
            help="Selected columns are checked for outliers; numeric text values are parsed when possible.",
        )
        iqr_multiplier = st.slider(
            "IQR outlier multiplier",
            min_value=1.5,
            max_value=3.0,
            value=1.5,
            step=0.1,
            format="%.1f×",
            help="Values outside Q1 − multiplier × IQR or Q3 + multiplier × IQR are flagged.",
        )
    st.divider()
    st.caption("Checks include missing values, exact duplicates, email/date formats, and numeric outliers.")

issues, duplicate_count = scan_data(
    data,
    email_columns=email_columns,
    date_columns=date_columns,
    numeric_columns=numeric_columns,
    iqr_multiplier=iqr_multiplier,
)
issue_count = len(issues)
health_score = max(0, round(100 * (1 - issue_count / max(data.shape[0] * data.shape[1], 1))))
st.caption(f"Inspecting **{st.session_state.get('inspector_source', 'dataset')}** · {data.shape[0]:,} rows · {data.shape[1]:,} columns")

metric_cards = [
    ("health", "Data Health Score", f"{health_score}%", "How the quality score is calculated"),
    ("rows", "Total Rows", f"{len(data):,}", "Dataset size and duplicate-row summary"),
    ("issues", "Total Issues Found", f"{issue_count:,}", "Breakdown of detected issues"),
    ("duplicates", "Duplicate Rows", f"{duplicate_count:,}", "Exact duplicate row details"),
]
with st.container(key="metric_cards"):
    metric_columns = st.columns(4)
    for metric_column, (metric_key, label, value, description) in zip(
        metric_columns, metric_cards
    ):
        with metric_column:
            if st.button(
                f"**{label}**\n\n**{value}**\n\nClick to explore",
                key=f"metric_card_{metric_key}",
                help=description,
                width="stretch",
            ):
                st.session_state["selected_metric_detail"] = metric_key

selected_metric = st.session_state.get("selected_metric_detail")
if selected_metric:
    selected_label = next(
        label for key, label, _, _ in metric_cards if key == selected_metric
    )
    with st.container(border=True):
        st.subheader(f"{selected_label} details")
        if selected_metric == "health":
            flagged_cells = issue_count
            total_cells = data.shape[0] * data.shape[1]
            st.markdown(
                f"The **{health_score}%** score is calculated as "
                f"`max(0, round(100 × (1 − {flagged_cells} ÷ {total_cells})))`. "
                f"There are **{flagged_cells:,} flagged findings** across "
                f"**{total_cells:,} cells** ({data.shape[0]:,} rows × {data.shape[1]:,} columns)."
            )
            if issues.empty:
                st.success("No quality issues are currently detected.")
            else:
                st.caption("Findings contributing to the score:")
                st.dataframe(
                    issues.groupby("Issue Type", as_index=False)
                    .size()
                    .rename(columns={"size": "Issue Count"})
                    .sort_values("Issue Count", ascending=False),
                    use_container_width=True,
                    hide_index=True,
                )
        elif selected_metric == "rows":
            unique_rows = len(data) - duplicate_count
            duplicate_percent = duplicate_count / len(data) * 100
            row_col, column_col, unique_col, duplicate_col = st.columns(4)
            row_col.metric("Rows in dataset", f"{len(data):,}")
            column_col.metric("Columns", f"{len(data.columns):,}")
            unique_col.metric("Rows after deduplication", f"{unique_rows:,}")
            duplicate_col.metric("Rows duplicated", f"{duplicate_percent:.1f}%")
            st.caption(
                "Row numbers in the issue log refer to the displayed data order, starting at 1."
            )
        elif selected_metric == "issues":
            if issues.empty:
                st.success("No issues are currently detected.")
            else:
                issue_type_counts = (
                    issues.groupby("Issue Type", as_index=False)
                    .size()
                    .rename(columns={"size": "Issue Count"})
                    .sort_values("Issue Count", ascending=False)
                )
                issue_column_counts = (
                    issues.groupby("Column Name", as_index=False)
                    .size()
                    .rename(columns={"size": "Issue Count"})
                    .sort_values("Issue Count", ascending=False)
                )
                type_column, field_column = st.columns(2)
                with type_column:
                    st.caption("Findings by issue type")
                    st.dataframe(issue_type_counts, use_container_width=True, hide_index=True)
                with field_column:
                    st.caption("Findings by column")
                    st.dataframe(issue_column_counts, use_container_width=True, hide_index=True)
                st.caption("Showing every detected issue:")
                st.dataframe(issues, use_container_width=True, hide_index=True)
        elif selected_metric == "duplicates":
            duplicate_mask = data.duplicated(keep="first").to_numpy()
            duplicate_positions = np.flatnonzero(duplicate_mask)
            if duplicate_count == 0:
                st.success("No exact duplicate rows are currently detected.")
            else:
                duplicate_rows = data.iloc[duplicate_positions].copy()
                duplicate_rows.insert(0, "Row Number", duplicate_positions + 1)
                st.markdown(
                    f"**{duplicate_count:,}** exact duplicate row(s) were found. "
                    "These rows match an earlier row across every column."
                )
                st.dataframe(duplicate_rows, use_container_width=True, hide_index=True)

overview_tab, issues_tab, preview_tab = st.tabs(
    ["Overview Dashboard", "Issue Logs", "Data Preview & Export"]
)

with overview_tab:
    chart_col, recommendations_col = st.columns([1.55, 1])
    with chart_col:
        st.subheader("Issues by column")
        if issues.empty:
            st.success("No quality issues detected.")
        else:
            issue_counts = (
                issues.groupby("Column Name", as_index=False)
                .size()
                .rename(columns={"size": "Issue Count"})
                .sort_values("Issue Count", ascending=False)
            )
            chart = px.bar(
                issue_counts,
                x="Column Name",
                y="Issue Count",
                color="Issue Count",
                color_continuous_scale=["#b9d5ff", "#4169e1"],
                text="Issue Count",
            )
            chart.update_layout(
                template="plotly_white",
                coloraxis_showscale=False,
                xaxis_title="",
                yaxis_title="Number of issues",
                margin=dict(l=10, r=10, t=15, b=10),
            )
            st.plotly_chart(chart, use_container_width=True)

    with recommendations_col:
        st.subheader("Top recommendations")
        issue_types = set(issues["Issue Type"]) if not issues.empty else set()
        recommendations = []
        if duplicate_count:
            recommendations.append(f"Remove {duplicate_count} duplicate row(s).")
        if "Missing Value" in issue_types:
            recommendations.append("Review missing values and choose field-appropriate replacements.")
        if "Invalid Email" in issue_types:
            recommendations.append("Correct malformed email addresses before using contact data.")
        if {"Invalid Date", "Inconsistent Date Format"} & issue_types:
            recommendations.append("Standardize date formats and correct unparseable date values.")
        if "Numeric Outlier" in issue_types:
            recommendations.append("Validate numeric outliers against the source before changing them.")
        if not recommendations:
            recommendations.append("Your dataset looks good. Continue to preview or export it.")
        for recommendation in recommendations:
            st.markdown(f"- {recommendation}")

with issues_tab:
    st.subheader("Detected issues")
    if issues.empty:
        st.success("No issues found. Your dataset passed all available checks.")
    else:
        filter_options = ["All issue types"] + sorted(issues["Issue Type"].unique().tolist())
        selected_type = st.selectbox("Filter by issue type", filter_options)
        filtered_issues = (
            issues if selected_type == "All issue types" else issues[issues["Issue Type"] == selected_type]
        )
        st.caption(f"Showing {len(filtered_issues):,} of {len(issues):,} detected issues")
        st.dataframe(filtered_issues, use_container_width=True, hide_index=True)

with preview_tab:
    st.subheader("Data preview")
    st.dataframe(data.head(100), use_container_width=True, hide_index=True)
    cleaned_data = clean_data(data)
    st.caption(
        f"One-click cleaning removes exact duplicates, trims text whitespace, "
        f"and fills missing numeric values with their column median. "
        f"Preview: {len(cleaned_data):,} rows after cleaning."
    )
    st.download_button(
        "Download Cleaned CSV",
        data=cleaned_data.to_csv(index=False).encode("utf-8"),
        file_name="cleaned_data.csv",
        mime="text/csv",
        type="primary",
    )
