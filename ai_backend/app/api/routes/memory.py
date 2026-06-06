from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.models import User
from app.db.session import get_db_session
from app.schemas.memory import MemoryCreateRequest
from app.schemas.training import TrainingExampleCreateRequest
from app.services.memory_service import memory_service


router = APIRouter(prefix="/memory")


@router.post("/text")
async def create_memory_text(
    payload: MemoryCreateRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    memory = await memory_service.add_memory_text(
        db=db,
        user_id=current_user.id,
        text=payload.text,
        source_type=payload.source_type,
        source_ref=payload.source_ref,
    )
    return {"memory_id": str(memory.id)}


@router.post("/upload")
async def upload_memory_file(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db_session),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    try:
        memory = await memory_service.add_uploaded_file_memory(db=db, user_id=current_user.id, upload=file)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {"memory_id": str(memory.id)}


@router.post("/training-example")
async def create_training_example(
    payload: TrainingExampleCreateRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    example = await memory_service.add_training_example(
        db=db,
        user_id=current_user.id,
        prompt=payload.prompt,
        ideal_response=payload.ideal_response,
        tags=payload.tags,
    )
    return {"training_example_id": str(example.id)}
